use crate::providers::Result;
use regex::Regex;
use std::collections::HashMap;
use std::sync::LazyLock;

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct ByteRange {
    pub start: u64,
    pub size: u64,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum Kind {
    Playlist,
    SubtitlePlaylist,
    Dash,
    Segment,
    Fragment,
    Init,
    Key,
    Caption,
    Mp4,
}

impl Kind {
    pub fn is_playlist(self) -> bool {
        matches!(self, Self::Playlist | Self::SubtitlePlaylist)
    }

    pub fn extension(self) -> &'static str {
        match self {
            Self::Playlist | Self::SubtitlePlaylist => "m3u8",
            Self::Dash => "mpd",
            Self::Segment => "ts",
            Self::Fragment => "m4s",
            Self::Init | Self::Mp4 => "mp4",
            Self::Key => "key",
            Self::Caption => "vtt",
        }
    }
}

static ATTR: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?:^|,)([A-Z0-9-]+)=("[^"]*"|[^,]+)"#).unwrap());

fn attrs(line: &str) -> impl Iterator<Item = (&str, &str)> {
    ATTR.captures_iter(line.split_once(':').map_or("", |(_, rest)| rest))
        .map(|capture| {
            (
                capture.get(1).unwrap().as_str(),
                capture.get(2).unwrap().as_str().trim_matches('"'),
            )
        })
}

fn attr<'a>(line: &'a str, key: &str) -> Option<&'a str> {
    attrs(line).find_map(|(name, value)| (name == key).then_some(value))
}

fn rewrite_attrs(line: &str, uri: &str, drop_range: bool) -> Result<String> {
    let (tag, rest) = line.split_once(':').ok_or("Некорректный тег HLS.")?;
    let values = ATTR
        .captures_iter(rest)
        .filter_map(|capture| {
            let key = capture.get(1).unwrap().as_str();
            match key {
                "URI" => Some(format!(r#"URI="{uri}""#)),
                "BYTERANGE" if drop_range => None,
                _ => Some(
                    capture
                        .get(0)
                        .unwrap()
                        .as_str()
                        .trim_start_matches(',')
                        .to_owned(),
                ),
            }
        })
        .collect::<Vec<_>>();
    Ok(format!("{tag}:{}", values.join(",")))
}

fn parse_range(raw: &str, implicit_start: Option<u64>) -> Result<ByteRange> {
    let (size, start) = match raw.split_once('@') {
        Some((size, start)) => (size, start.parse().ok()),
        None => (raw, implicit_start),
    };
    let (size, start) = size
        .parse::<u64>()
        .ok()
        .zip(start)
        .filter(|(size, start)| *size > 0 && start.checked_add(*size).is_some())
        .ok_or("Некорректный диапазон HLS.")?;
    Ok(ByteRange { start, size })
}

pub fn localize(
    text: &str,
    quality: u32,
    kind: Kind,
    mut register: impl FnMut(&str, Kind, Option<ByteRange>) -> Result<String>,
) -> Result<String> {
    let text = text.trim_start_matches('\u{feff}');
    if !text.starts_with("#EXTM3U") || text.len() > 512_000 {
        return Err("Некорректный плейлист HLS.".into());
    }
    let lines: Vec<_> = text.lines().map(str::trim).collect();
    let mut output = String::from("#EXTM3U\n");
    if lines
        .iter()
        .any(|line| line.starts_with("#EXT-X-STREAM-INF:"))
    {
        let mut variants = Vec::new();
        for (index, line) in lines.iter().enumerate() {
            if !line.starts_with("#EXT-X-STREAM-INF:") {
                continue;
            }
            let uri = lines[index + 1..]
                .iter()
                .find(|line| !line.is_empty() && !line.starts_with('#'))
                .ok_or("В HLS нет адреса видеодорожки.")?;
            let height = attr(line, "RESOLUTION")
                .and_then(|value| value.split_once('x')?.1.parse::<u32>().ok());
            let bandwidth = attr(line, "BANDWIDTH")
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(0);
            variants.push((*line, *uri, height, bandwidth));
        }
        let &(variant, uri, _, _) = variants
            .iter()
            .filter(|(_, _, height, _)| *height == Some(quality))
            .max_by_key(|(_, _, _, bandwidth)| *bandwidth)
            .or_else(|| (variants.len() == 1 && variants[0].2.is_none()).then(|| &variants[0]))
            .ok_or_else(|| format!("В плейлисте HLS нет качества {quality}p."))?;
        for media_type in ["AUDIO", "SUBTITLES", "CLOSED-CAPTIONS"] {
            let Some(group) = attr(variant, media_type).filter(|group| *group != "NONE") else {
                continue;
            };
            let tracks = lines.iter().filter(|line| {
                line.starts_with("#EXT-X-MEDIA:")
                    && attr(line, "TYPE") == Some(media_type)
                    && attr(line, "GROUP-ID") == Some(group)
            });
            let selected: Vec<_> = if media_type == "CLOSED-CAPTIONS" {
                tracks.copied().collect()
            } else {
                let mut tracks = tracks.copied();
                let first = tracks.next();
                first
                    .and_then(|first| {
                        std::iter::once(first)
                            .chain(tracks)
                            .find(|track| attr(track, "DEFAULT") == Some("YES"))
                            .or(Some(first))
                    })
                    .into_iter()
                    .collect()
            };
            if selected.is_empty() {
                return Err("В HLS отсутствует заявленная дорожка.".into());
            }
            for track in selected {
                let local = if let Some(raw) = attr(track, "URI") {
                    let kind = if media_type == "SUBTITLES" {
                        Kind::SubtitlePlaylist
                    } else {
                        Kind::Playlist
                    };
                    rewrite_attrs(track, &register(raw, kind, None)?, false)?
                } else {
                    track.to_owned()
                };
                output.push_str(&local);
                output.push('\n');
            }
        }
        for line in &lines {
            if line.starts_with("#EXT-X-SESSION-KEY:") {
                output.push_str(&local_key(line, &mut register)?);
                output.push('\n');
            } else if line.starts_with("#EXT-X-VERSION:") || *line == "#EXT-X-INDEPENDENT-SEGMENTS"
            {
                output.push_str(line);
                output.push('\n');
            }
        }
        output.push_str(variant);
        output.push('\n');
        output.push_str(&register(uri, Kind::Playlist, None)?);
        output.push('\n');
        return Ok(output);
    }

    let mut range = None;
    let mut previous = None;
    let mut init_end = HashMap::new();
    let mut segments = 0;
    let mut segment_kind = if kind == Kind::SubtitlePlaylist {
        Kind::Caption
    } else {
        Kind::Segment
    };
    for line in lines.into_iter().skip(1) {
        let local = if let Some(value) = line.strip_prefix("#EXT-X-BYTERANGE:") {
            range = Some(value);
            continue;
        } else if line.starts_with("#EXT-X-MAP:") {
            let uri = attr(line, "URI").ok_or("В HLS отсутствует адрес инициализации.")?;
            let bytes = attr(line, "BYTERANGE")
                .map(|value| parse_range(value, init_end.get(uri).copied()))
                .transpose()?;
            if let Some(bytes) = bytes {
                init_end.insert(uri, bytes.start + bytes.size);
            }
            if kind != Kind::SubtitlePlaylist {
                segment_kind = Kind::Fragment;
            }
            rewrite_attrs(line, &register(uri, Kind::Init, bytes)?, true)?
        } else if line.starts_with("#EXT-X-KEY:") {
            local_key(line, &mut register)?
        } else if line.starts_with("#EXT-X-PART:")
            || line.starts_with("#EXT-X-PRELOAD-HINT:")
            || line.starts_with("#EXT-X-RENDITION-REPORT:")
            || line.starts_with("#EXT-X-SERVER-CONTROL:")
            || line.starts_with("#EXT-X-PART-INF:")
        {
            continue;
        } else if line.starts_with('#') {
            if attr(line, "URI").is_some() || line.starts_with("#EXT-X-SKIP:") {
                return Err("Плейлист использует неподдерживаемые ссылки HLS.".into());
            }
            line.to_owned()
        } else if line.is_empty() {
            continue;
        } else {
            let next = previous.filter(|(uri, _)| *uri == line).map(|(_, end)| end);
            let bytes = range
                .take()
                .map(|value| parse_range(value, next))
                .transpose()?;
            previous = bytes.map(|value| (line, value.start + value.size));
            segments += 1;
            register(line, segment_kind, bytes)?
        };
        output.push_str(&local);
        output.push('\n');
    }
    if segments == 0 || range.is_some() {
        return Err("В плейлисте HLS нет полных сегментов.".into());
    }
    if output
        .lines()
        .any(|line| line == "#EXT-X-PLAYLIST-TYPE:VOD")
        && !output.lines().any(|line| line == "#EXT-X-ENDLIST")
    {
        output.push_str("#EXT-X-ENDLIST\n");
    }
    Ok(output)
}

fn local_key(
    line: &str,
    register: &mut impl FnMut(&str, Kind, Option<ByteRange>) -> Result<String>,
) -> Result<String> {
    match (attr(line, "METHOD"), attr(line, "KEYFORMAT")) {
        (Some("NONE"), _) => Ok(line.into()),
        (Some("AES-128"), None | Some("identity")) => {
            let uri = attr(line, "URI").ok_or("В плейлисте HLS отсутствует ключ.")?;
            rewrite_attrs(line, &register(uri, Kind::Key, None)?, false)
        }
        _ => Err("Этот формат защищённого HLS нельзя сохранить.".into()),
    }
}

pub fn hls_skips(text: &str) -> serde_json::Value {
    use serde_json::{json, Map, Value};
    use time::{format_description::well_known::Rfc3339, OffsetDateTime};
    if !text.contains("#EXT-X-DATERANGE:") {
        return Value::Null;
    }
    let date = |raw: &str| {
        OffsetDateTime::parse(raw, &Rfc3339)
            .ok()
            .map(|value| value.unix_timestamp_nanos() as f64 / 1_000_000_000.0)
    };
    let seconds = |raw: &str| {
        raw.parse::<f64>()
            .ok()
            .filter(|value| value.is_finite() && *value >= 0.0)
    };
    let mut offset = 0.0;
    let mut pending = 0.0;
    let mut anchor = None;
    let mut ranges = Vec::new();
    for line in text.lines() {
        if let Some(length) = line
            .strip_prefix("#EXTINF:")
            .and_then(|v| v.split(',').next())
            .and_then(seconds)
        {
            pending = length;
        } else if !line.is_empty() && !line.starts_with('#') {
            offset += pending;
            pending = 0.0;
        } else if let Some(raw) = line.strip_prefix("#EXT-X-PROGRAM-DATE-TIME:") {
            if anchor.is_none() {
                anchor = date(raw).map(|value| value - offset);
            }
        } else if line.starts_with("#EXT-X-DATERANGE:") {
            ranges.push(line);
        }
    }
    let mut result = Map::new();
    for range in ranges {
        let label = ["CLASS", "ID", "X-TITLE"]
            .iter()
            .filter_map(|tag| attr(range, tag))
            .collect::<Vec<_>>()
            .join(" ")
            .to_lowercase();
        let words: Vec<_> = label.split(|c: char| !c.is_alphanumeric()).collect();
        let kind = if words
            .iter()
            .any(|word| matches!(*word, "op" | "intro" | "opening" | "опенинг" | "заставка"))
        {
            "opening"
        } else if words.iter().any(|word| {
            matches!(
                *word,
                "ed" | "ending" | "outro" | "credits" | "титры" | "эндинг"
            )
        }) {
            "ending"
        } else {
            continue;
        };
        let relative = |tag| {
            attr(range, tag)
                .and_then(date)
                .zip(anchor)
                .map(|(at, start)| at - start)
        };
        let Some(start) = attr(range, "X-START-TIME")
            .and_then(seconds)
            .or_else(|| relative("START-DATE"))
        else {
            continue;
        };
        let end = attr(range, "X-END-TIME")
            .and_then(seconds)
            .or_else(|| {
                attr(range, "DURATION")
                    .and_then(seconds)
                    .map(|duration| start + duration)
            })
            .or_else(|| relative("END-DATE"));
        if let Some(end) = end.filter(|end| start >= 0.0 && *end > start && *end <= 86400.0) {
            result.insert(kind.into(), json!({"time":start,"length":end-start}));
        }
    }
    Value::Object(result)
}
