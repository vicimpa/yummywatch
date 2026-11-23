use crate::providers::Result;
#[cfg(desktop)]
use quick_xml::escape::escape;
use quick_xml::{escape::unescape, events::Event, Reader};
use std::{collections::HashMap, fmt::Write, sync::LazyLock};
use url::Url;

const INVALID: &str = "Некорректный или неподдерживаемый манифест DASH.";
const LIMIT: usize = 8190;

#[derive(Default)]
struct Node {
    name: String,
    attrs: HashMap<String, String>,
    text: String,
    children: Vec<Node>,
}

impl Node {
    fn attr(&self, name: &str) -> Option<&str> {
        self.attrs.get(name).map(String::as_str)
    }
    fn nodes<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a Node> {
        self.children.iter().filter(move |node| node.name == name)
    }
    fn child(&self, name: &str) -> Option<&Node> {
        self.children.iter().find(|node| node.name == name)
    }
    fn base(&self, parent: &Url) -> Result<Url> {
        match self.child("BaseURL") {
            Some(value) => parent.join(value.text.trim()).map_err(|_| INVALID.into()),
            None => Ok(parent.clone()),
        }
    }
}

fn parse(text: &str) -> Result<Node> {
    if text.len() > 512_000 {
        return Err(INVALID.into());
    }
    let mut reader = Reader::from_str(text);
    reader.config_mut().expand_empty_elements = true;
    let mut stack = vec![Node::default()];
    let mut count = 0;
    loop {
        match reader.read_event().map_err(|_| INVALID)? {
            Event::Start(start) => {
                count += 1;
                if count > LIMIT || stack.len() > 24 {
                    return Err(INVALID.into());
                }
                let name = start.local_name().as_ref().to_owned();
                if name == "ContentProtection" {
                    return Err("Этот DASH использует защиту контента.".into());
                }
                let mut attrs = HashMap::new();
                for attr in start.attributes() {
                    let attr = attr.map_err(|_| INVALID)?;
                    let key = attr.key.as_ref().to_owned();
                    let raw = attr.value.as_ref();
                    attrs.insert(key, unescape(raw).map_err(|_| INVALID)?.into_owned());
                }
                stack.push(Node {
                    name,
                    attrs,
                    ..Node::default()
                });
            }
            Event::End(_) => {
                if stack.len() < 2 {
                    return Err(INVALID.into());
                }
                let node = stack.pop().unwrap();
                stack.last_mut().unwrap().children.push(node);
            }
            Event::Text(text) => {
                let node = stack.last_mut().unwrap();
                if node.name == "BaseURL" {
                    node.text.push_str(text.as_ref());
                }
            }
            // A provider manifest needs no external XML entities or document type.
            Event::DocType(_) => return Err(INVALID.into()),
            Event::GeneralRef(reference) => {
                let node = stack.last_mut().unwrap();
                if node.name == "BaseURL" {
                    let reference = reference.as_ref();
                    node.text
                        .push_str(&unescape(&format!("&{reference};")).map_err(|_| INVALID)?);
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    if stack.len() != 1 || stack[0].children.len() != 1 || stack[0].children[0].name != "MPD" {
        return Err(INVALID.into());
    }
    Ok(stack.pop().unwrap().children.pop().unwrap())
}

static TEMPLATE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"\$([^$]*)\$").unwrap());

fn url(template: &str, base: &Url, rep: &Node, number: u64, time: u64) -> Result<Url> {
    let mut value = String::new();
    let mut end = 0;
    for token in TEMPLATE.captures_iter(template) {
        let placeholder = token.get(0).unwrap();
        let literal = &template[end..placeholder.start()];
        if literal.contains('$') {
            return Err(INVALID.into());
        }
        value.push_str(literal);
        end = placeholder.end();
        let key = &token[1];
        if key.is_empty() {
            value.push('$');
            continue;
        }
        if key == "RepresentationID" {
            value.push_str(rep.attr("id").ok_or(INVALID)?);
            continue;
        }
        let (key, width) = if let Some((key, width)) = key.split_once("%0") {
            let width = width
                .strip_suffix('d')
                .and_then(|n| n.parse::<usize>().ok())
                .filter(|n| *n <= 12)
                .ok_or(INVALID)?;
            (key, width)
        } else {
            (key, 0)
        };
        let number = match key {
            "Number" => number,
            "Time" => time,
            "Bandwidth" => rep
                .attr("bandwidth")
                .and_then(|n| n.parse().ok())
                .ok_or(INVALID)?,
            _ => return Err(INVALID.into()),
        };
        write!(value, "{number:0width$}").unwrap();
    }
    let tail = &template[end..];
    if tail.contains('$') {
        return Err(INVALID.into());
    }
    value.push_str(tail);
    base.join(&value).map_err(|_| INVALID.into())
}

fn number(node: &Node, name: &str) -> Result<Option<u64>> {
    node.attr(name)
        .map(|value| value.parse().map_err(|_| INVALID.into()))
        .transpose()
}

#[cfg(desktop)]
fn attrs(out: &mut String, node: &Node, names: &[&str]) {
    for name in names {
        if let Some(value) = node.attr(name) {
            write!(out, " {name}=\"{}\"", escape(value)).unwrap();
        }
    }
}

#[derive(Default)]
#[cfg(desktop)]
pub struct Manifest {
    pub text: String,
    pub parts: Vec<(String, Url)>,
}

fn representation_kind(set: &Node, rep: &Node) -> Option<&'static str> {
    match set.attr("contentType").or_else(|| {
        rep.attr("mimeType")
            .or_else(|| set.attr("mimeType"))?
            .split_once('/')
            .map(|(kind, _)| kind)
    }) {
        Some("video") => Some("video"),
        Some("audio") => Some("audio"),
        _ => None,
    }
}

struct SegmentTemplate<'a> {
    scale: u64,
    start: u64,
    #[cfg(desktop)]
    offset: u64,
    media: &'a str,
    init: &'a str,
    timeline: &'a Node,
}

fn segment_template<'a>(
    period: &'a Node,
    set: &'a Node,
    rep: &'a Node,
) -> Result<SegmentTemplate<'a>> {
    let templates = [
        rep.child("SegmentTemplate"),
        set.child("SegmentTemplate"),
        period.child("SegmentTemplate"),
    ];
    let attribute = |name| templates.iter().flatten().find_map(|node| node.attr(name));
    let timeline = templates
        .iter()
        .flatten()
        .find_map(|node| node.child("SegmentTimeline"))
        .ok_or(INVALID)?;
    let scale = attribute("timescale")
        .unwrap_or("1")
        .parse::<u64>()
        .ok()
        .filter(|n| *n > 0)
        .ok_or(INVALID)?;
    let start = attribute("startNumber")
        .unwrap_or("1")
        .parse::<u64>()
        .map_err(|_| INVALID)?;
    Ok(SegmentTemplate {
        scale,
        start,
        #[cfg(desktop)]
        offset: attribute("presentationTimeOffset")
            .unwrap_or("0")
            .parse::<u64>()
            .map_err(|_| INVALID)?,
        media: attribute("media").ok_or(INVALID)?,
        init: attribute("initialization").ok_or(INVALID)?,
        timeline,
    })
}

fn timeline_runs(timeline: &Node) -> Result<Vec<(u64, u64, u64)>> {
    let segments: Vec<_> = timeline.nodes("S").collect();
    if segments.is_empty() {
        return Err(INVALID.into());
    }
    let mut time = 0;
    let mut runs = Vec::with_capacity(segments.len());
    for (index, segment) in segments.iter().enumerate() {
        let duration = number(segment, "d")?
            .filter(|num| *num > 0)
            .ok_or(INVALID)?;
        time = number(segment, "t")?.unwrap_or(time);
        let repeat = match segment.attr("r").unwrap_or("0") {
            "-1" => {
                let count = segments
                    .get(index + 1)
                    .map(|next| number(next, "t"))
                    .transpose()?
                    .flatten()
                    .and_then(|next| next.checked_sub(time))
                    .filter(|distance| *distance > 0 && *distance % duration == 0)
                    .ok_or(INVALID)?;
                count / duration - 1
            }
            value => value.parse::<u64>().map_err(|_| INVALID)?,
        };
        runs.push((time, duration, repeat));
        time = duration
            .checked_mul(repeat.checked_add(1).ok_or(INVALID)?)
            .and_then(|span| time.checked_add(span))
            .ok_or(INVALID)?;
    }
    Ok(runs)
}

#[cfg(desktop)]
fn write_track(
    manifest: &mut Manifest,
    index: usize,
    period: &Node,
    set: &Node,
    rep: &Node,
    base: &Url,
) -> Result<()> {
    let base = rep.base(&set.base(base)?)?;
    let SegmentTemplate {
        scale,
        start,
        offset,
        media,
        init,
        timeline,
    } = segment_template(period, set, rep)?;
    let kind = representation_kind(set, rep).ok_or(INVALID)?;
    let Manifest { text, parts } = manifest;
    let init_name = format!("d{index}-init.m4s");
    parts.push((init_name.clone(), url(init, &base, rep, start, 0)?));
    write!(text, "<AdaptationSet contentType=\"{kind}\"").unwrap();
    attrs(
        text,
        set,
        &["mimeType", "lang", "segmentAlignment", "startWithSAP"],
    );
    text.push_str("><Representation");
    attrs(
        text,
        rep,
        &[
            "id",
            "mimeType",
            "codecs",
            "bandwidth",
            "width",
            "height",
            "frameRate",
            "sar",
            "audioSamplingRate",
        ],
    );
    write!(text, "><SegmentTemplate timescale=\"{scale}\" startNumber=\"{start}\" presentationTimeOffset=\"{offset}\" initialization=\"{init_name}\" media=\"d{index}-$Number$.m4s\"><SegmentTimeline>").unwrap();

    let mut seq = start;
    for (mut time, duration, repeat) in timeline_runs(timeline)? {
        if repeat >= LIMIT as u64 || parts.len() + repeat as usize + 1 > LIMIT {
            return Err("Слишком много сегментов DASH.".into());
        }
        write!(text, "<S t=\"{time}\" d=\"{duration}\" r=\"{repeat}\"/>").unwrap();
        for _ in 0..=repeat {
            if seq > i64::MAX as u64 || time > i64::MAX as u64 {
                return Err(INVALID.into());
            }
            parts.push((
                format!("d{index}-{seq}.m4s"),
                url(media, &base, rep, seq, time)?,
            ));
            time = time.checked_add(duration).ok_or(INVALID)?;
            seq = seq.checked_add(1).ok_or(INVALID)?;
        }
    }
    text.push_str("</SegmentTimeline></SegmentTemplate></Representation></AdaptationSet>");
    Ok(())
}

#[cfg(desktop)]
pub fn localize(text: &str, quality: u32, url: &Url) -> Result<Manifest> {
    let root = parse(text)?;
    if !matches!(root.attr("type"), None | Some("static")) || root.nodes("Period").count() != 1 {
        return Err("Для скачивания DASH нужна полная запись серии.".into());
    }
    let period = root.child("Period").unwrap();
    if root.attr("mediaPresentationDuration").is_none() && period.attr("duration").is_none() {
        return Err(INVALID.into());
    }
    let base = period.base(&root.base(url)?)?;
    let candidates: Vec<_> = period
        .nodes("AdaptationSet")
        .flat_map(|set| set.nodes("Representation").map(move |rep| (set, rep)))
        .collect();
    let video: Vec<_> = candidates
        .iter()
        .copied()
        .filter(|(set, rep)| representation_kind(set, rep) == Some("video"))
        .collect();
    let height = |rep: &Node| rep.attr("height").and_then(|v| v.parse::<u32>().ok());
    let (set, rep) = video
        .iter()
        .copied()
        .filter(|(_, rep)| height(rep) == Some(quality))
        .max_by_key(|(_, rep)| number(rep, "bandwidth").ok().flatten().unwrap_or(0))
        .or_else(|| (video.len() == 1 && height(video[0].1).is_none()).then(|| video[0]))
        .ok_or_else(|| format!("В плейлисте DASH нет качества {quality}p."))?;
    let mut result = Manifest::default();
    result
        .text
        .push_str("<MPD xmlns=\"urn:mpeg:DASH:schema:MPD:2011\" type=\"static\"");
    attrs(
        &mut result.text,
        &root,
        &[
            "mediaPresentationDuration",
            "minBufferTime",
            "maxSegmentDuration",
            "profiles",
        ],
    );
    result.text.push_str("><Period");
    attrs(&mut result.text, period, &["id", "start", "duration"]);
    result.text.push('>');
    write_track(&mut result, 0, period, set, rep, &base)?;
    if let Some((set, rep)) = candidates
        .iter()
        .copied()
        .filter(|(set, rep)| representation_kind(set, rep) == Some("audio"))
        .max_by_key(|(set, rep)| {
            let main = set
                .nodes("Role")
                .any(|role| role.attr("value") == Some("main"));
            (main, number(rep, "bandwidth").ok().flatten().unwrap_or(0))
        })
    {
        write_track(&mut result, 1, period, set, rep, &base)?;
    }
    result.text.push_str("</Period></MPD>");
    Ok(result)
}

pub(crate) struct HlsTrack {
    pub kind: &'static str,
    pub bandwidth: u64,
    pub playlist: String,
}

pub(crate) fn hls_tracks(
    text: &str,
    manifest_url: &Url,
    mut register: impl FnMut(Url) -> Result<String>,
) -> Result<Vec<HlsTrack>> {
    let root = parse(text)?;
    if !matches!(root.attr("type"), None | Some("static")) || root.nodes("Period").count() != 1 {
        return Err(INVALID.into());
    }
    let period = root.child("Period").ok_or(INVALID)?;
    let base = period.base(&root.base(manifest_url)?)?;
    let mut parts = 0;
    let mut tracks = Vec::new();
    for kind in ["video", "audio"] {
        let chosen = period
            .nodes("AdaptationSet")
            .flat_map(|set| set.nodes("Representation").map(move |rep| (set, rep)))
            .filter(|(set, rep)| representation_kind(set, rep) == Some(kind))
            .max_by_key(|(set, rep)| {
                let main = set
                    .nodes("Role")
                    .any(|role| role.attr("value") == Some("main"));
                (main, number(rep, "bandwidth").ok().flatten().unwrap_or(0))
            });
        let Some((set, rep)) = chosen else {
            if kind == "video" {
                return Err(INVALID.into());
            }
            continue;
        };
        let base = rep.base(&set.base(&base)?)?;
        let template = segment_template(period, set, rep)?;
        let runs = timeline_runs(template.timeline)?;
        let target = runs
            .iter()
            .map(|(_, duration, _)| duration.div_ceil(template.scale))
            .max()
            .ok_or(INVALID)?;
        let mut seq = template.start;
        let init = register(url(template.init, &base, rep, seq, 0)?)?;
        parts += 1;
        let mut playlist = format!("#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-TARGETDURATION:{target}\n#EXT-X-MEDIA-SEQUENCE:{seq}\n#EXT-X-MAP:URI=\"{init}\"\n");
        for (mut time, duration, repeat) in runs {
            if repeat >= LIMIT as u64 || parts + repeat as usize + 1 > LIMIT {
                return Err("Слишком много сегментов DASH.".into());
            }
            parts += repeat as usize + 1;
            let seconds = duration as f64 / template.scale as f64;
            for _ in 0..=repeat {
                let media = register(url(template.media, &base, rep, seq, time)?)?;
                writeln!(playlist, "#EXTINF:{seconds:.6},\n{media}").unwrap();
                time = time.checked_add(duration).ok_or(INVALID)?;
                seq = seq.checked_add(1).ok_or(INVALID)?;
            }
        }
        playlist.push_str("#EXT-X-ENDLIST\n");
        tracks.push(HlsTrack {
            kind,
            bandwidth: number(rep, "bandwidth")?.unwrap_or(1).max(1),
            playlist,
        });
    }
    Ok(tracks)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn localizes_static_video_and_audio_templates_with_repeated_segments() {
        let text = r#"<MPD xmlns="urn:mpeg:DASH:schema:MPD:2011" type="static" mediaPresentationDuration="PT6S">
          <Period>
            <AdaptationSet contentType="video">
              <SegmentTemplate timescale="1000" startNumber="3" initialization="init-$RepresentationID$.m4s" media="video-$RepresentationID$-$Number%05d$.m4s">
                <SegmentTimeline><S t="10" d="2000" r="2"/></SegmentTimeline>
              </SegmentTemplate>
              <Representation id="v720" height="720" width="1280" bandwidth="10000" mimeType="video/mp4"/>
              <Representation id="v1080" height="1080" width="1920" bandwidth="20000" mimeType="video/mp4"/>
            </AdaptationSet>
            <AdaptationSet contentType="audio">
              <SegmentTemplate timescale="48000" initialization="init-a.m4s" media="audio-$Time$.m4s">
                <SegmentTimeline><S d="144000" r="1"/></SegmentTimeline>
              </SegmentTemplate>
              <Representation id="a" mimeType="audio/mp4" bandwidth="100"/>
            </AdaptationSet>
          </Period>
        </MPD>"#;
        let base = Url::parse("https://cdn.aksor.tv/video/main.mpd").unwrap();
        let manifest = localize(text, 720, &base).unwrap();
        assert!(manifest.text.contains(r#"media="d0-$Number$.m4s""#));
        assert!(manifest.text.contains(r#"startNumber="3""#));
        assert!(manifest.text.contains(r#"<S t="10" d="2000" r="2"/>"#));
        assert!(!manifest.text.contains("v1080"));
        assert_eq!(manifest.parts.len(), 7);
        assert_eq!(manifest.parts[1].0, "d0-3.m4s");
        assert_eq!(manifest.parts[1].1.path(), "/video/video-v720-00003.m4s");
        assert_eq!(
            manifest.parts.last().unwrap().1.path(),
            "/video/audio-144000.m4s"
        );
        assert!(localize(&text.replace("static", "dynamic"), 720, &base).is_err());

        let tracks = hls_tracks(text, &base, |url| Ok(url.path().to_owned())).unwrap();
        assert_eq!(tracks.len(), 2);
        assert_eq!((tracks[0].kind, tracks[0].bandwidth), ("video", 20000));
        assert!(tracks[0].playlist.contains("#EXT-X-MEDIA-SEQUENCE:3"));
        assert!(tracks[0]
            .playlist
            .contains(r#"URI="/video/init-v1080.m4s""#));
        assert!(tracks[0]
            .playlist
            .contains("#EXTINF:2.000000,\n/video/video-v1080-00005.m4s"));
        assert_eq!(tracks[1].kind, "audio");
        assert!(tracks[1]
            .playlist
            .contains("#EXTINF:3.000000,\n/video/audio-144000.m4s\n#EXT-X-ENDLIST"));
    }
}
