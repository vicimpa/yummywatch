#!/usr/bin/env bash
set -euo pipefail

output=${1:?Pass the output directory}
mkdir -p "$output"
output=$(cd "$output" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
prefix="$work/prefix"
target=x86_64-w64-mingw32
jobs=${YUMIWATCH_MPV_JOBS:-$(nproc)}
sources="$work/sources"

source_archive() {
  local name=$1 url=$2 sha256=$3
  local archive="$work/$name"
  curl --fail --location --retry 3 --silent --show-error "$url" -o "$archive"
  echo "$sha256  $archive" | sha256sum --check
  mkdir "$work/${name%%.tar.*}"
  tar xf "$archive" --strip-components 1 -C "$work/${name%%.tar.*}"
  echo "$name $url SHA-256: $sha256" >> "$sources"
}

source_archive mpv-0.42.0.tar.gz https://codeload.github.com/mpv-player/mpv/tar.gz/refs/tags/v0.42.0 bcfebbfa2b65a6d88dc97ea18117831072373e38b5785a2afb874ed4df5070dd
source_archive ffmpeg-8.1.tar.xz https://ffmpeg.org/releases/ffmpeg-8.1.tar.xz b072aed6871998cce9b36e7774033105ca29e33632be5b6347f3206898e0756a
source_archive libplacebo-7.387.0.tar.gz https://codeload.github.com/haasn/libplacebo/tar.gz/refs/tags/v7.387.0 f9e62d3774a9c4cfd198ec3abaa88294aaade2e31c04d5ab02bcf4abc98b1df5
source_archive libass-0.17.4.tar.gz https://codeload.github.com/libass/libass/tar.gz/refs/tags/0.17.4 c287d180d93dc9c9021872574b618ac49027e84cc90e1289318b1ee68bb42251
source_archive freetype-2.14.1.tar.gz https://codeload.github.com/freetype/freetype/tar.gz/refs/tags/VER-2-14-1 44bd69d1f0750603410cfd4f26f1c5523c5a3a087a2dfa8639b757dc7c6677be
source_archive fribidi-1.0.16.tar.gz https://codeload.github.com/fribidi/fribidi/tar.gz/refs/tags/v1.0.16 5a1d187a33daa58fcee2ad77f0eb9d136dd6fa4096239199ba31e850d397e8a8
source_archive harfbuzz-12.1.0.tar.gz https://codeload.github.com/harfbuzz/harfbuzz/tar.gz/refs/tags/12.1.0 0238bf7ada6b1fb92984f69f8b9cd66518af83cf24f7db1cfe60c772c42312d3
source_archive fast_float-8.1.0.tar.gz https://codeload.github.com/fastfloat/fast_float/tar.gz/refs/tags/v8.1.0 4bfabb5979716995090ce68dce83f88f99629bc17ae280eae79311c5340143e1
source_archive vulkan-headers-1.4.321.tar.gz https://codeload.github.com/KhronosGroup/Vulkan-Headers/tar.gz/refs/tags/v1.4.321 7c1874f9186d9e7d5245e279cdccaa77a66ed8f52871b428630aeb771dc7623c
source_archive libxml2-2.15.4.tar.xz https://download.gnome.org/sources/libxml2/2.15/libxml2-2.15.4.tar.xz 98087fd181d9070724f3fbc65c7377db03038eb92bd882374daff44940138821
source_archive shaderc-2025.5.tar.gz https://codeload.github.com/google/shaderc/tar.gz/refs/tags/v2025.5 fca5041b1fdea6daba167b63e04e55e5059fab40828342126169336643445447
source_archive glslang-shaderc.tar.gz https://codeload.github.com/KhronosGroup/glslang/tar.gz/7a47e2531cb334982b2a2dd8513dca0a3de4373d 272d2725b140e09e85b96eecdc59c2e00c1a14cda2301767e1bf3c363a44b931
source_archive spirv-headers-shaderc.tar.gz https://codeload.github.com/KhronosGroup/SPIRV-Headers/tar.gz/b824a462d4256d720bebb40e78b9eb8f78bbb305 c693867f10a7760ef1bcf85419d51783586768cc2c601d03841bc6a8b2554b9c
source_archive spirv-tools-shaderc.tar.gz https://codeload.github.com/KhronosGroup/SPIRV-Tools/tar.gz/262bdab48146c937467f826699a40da0fdfc0f1a 8f830936b057003be77e90d37068ff6066eb87a1bab0033f8f2f5feaa966ce56
source_archive spirv-cross-1.4.321.tar.gz https://codeload.github.com/KhronosGroup/SPIRV-Cross/tar.gz/refs/tags/vulkan-sdk-1.4.321.0 6037555620c27105bf1d4068a6eeb4b0d7953630d556a1ca9799dfe06fd2fb68

cp -R "$work/vulkan-headers-1.4.321"/. "$work/libplacebo-7.387.0/3rdparty/Vulkan-Headers/"
cp -R "$work/fast_float-8.1.0"/. "$work/libplacebo-7.387.0/3rdparty/fast_float/"

export PKG_CONFIG_LIBDIR="$prefix/lib/pkgconfig"
unset PKG_CONFIG_PATH
cat > "$work/cross.ini" <<CONFIG
[binaries]
c = '$target-gcc-posix'
cpp = '$target-g++-posix'
ar = '$target-ar'
strip = '$target-strip'
windres = '$target-windres'
dlltool = '$target-dlltool'
nasm = 'nasm'
pkg-config = 'pkg-config'
[built-in options]
c_link_args = ['-static']
cpp_link_args = ['-static']
[host_machine]
system = 'windows'
cpu_family = 'x86_64'
cpu = 'x86_64'
endian = 'little'
[properties]
needs_exe_wrapper = true
CONFIG

build() {
  local project=$1 library=$2
  shift 2
  meson setup "$work/$project/build" "$work/$project" --cross-file "$work/cross.ini" \
    --wrap-mode=nodownload --prefix="$prefix" --libdir=lib \
    --buildtype=minsize --strip --default-library="$library" \
    -Dauto_features=disabled -Dprefer_static=true "$@"
  meson compile -C "$work/$project/build" -j "$jobs"
  meson install -C "$work/$project/build" --no-rebuild
}

build freetype-2.14.1 static -Dharfbuzz=disabled -Dzlib=disabled
build fribidi-1.0.16 static -Ddocs=false -Dbin=false -Dtests=false
build harfbuzz-12.1.0 static -Dfreetype=enabled -Dtests=disabled -Dutilities=disabled
build libass-0.17.4 static -Ddirectwrite=enabled -Dasm=enabled
build libplacebo-7.387.0 static -Ddemos=false

cat > "$work/cross.cmake" <<CONFIG
set(CMAKE_SYSTEM_NAME Windows)
set(CMAKE_C_COMPILER $target-gcc-posix)
set(CMAKE_CXX_COMPILER $target-g++-posix)
set(CMAKE_RC_COMPILER $target-windres)
CONFIG
cmake -S "$work/libxml2-2.15.4" -B "$work/libxml2-2.15.4/build" -G Ninja \
  -DCMAKE_TOOLCHAIN_FILE="$work/cross.cmake" -DCMAKE_INSTALL_PREFIX="$prefix" \
  -DCMAKE_INSTALL_LIBDIR=lib -DCMAKE_BUILD_TYPE=MinSizeRel -DBUILD_SHARED_LIBS=OFF \
  -DLIBXML2_WITH_ICONV=OFF -DLIBXML2_WITH_ZLIB=OFF -DLIBXML2_WITH_PYTHON=OFF \
  -DLIBXML2_WITH_PROGRAMS=OFF -DLIBXML2_WITH_TESTS=OFF
cmake --build "$work/libxml2-2.15.4/build" --target install -j "$jobs"

# Keep the D3D11 shader dependencies static so the installer ships one DLL.
shaderc="$work/shaderc-2025.5"
cmake -S "$shaderc" -B "$shaderc/build" -G Ninja \
  -DCMAKE_TOOLCHAIN_FILE="$work/cross.cmake" -DCMAKE_INSTALL_PREFIX="$prefix" \
  -DCMAKE_INSTALL_LIBDIR=lib -DCMAKE_BUILD_TYPE=MinSizeRel \
  -DSHADERC_SKIP_TESTS=ON -DSHADERC_SKIP_EXAMPLES=ON -DSPIRV_SKIP_EXECUTABLES=ON \
  -DENABLE_GLSLANG_BINARIES=OFF \
  -DSHADERC_GLSLANG_DIR="$work/glslang-shaderc" \
  -DSHADERC_SPIRV_HEADERS_DIR="$work/spirv-headers-shaderc" \
  -DSHADERC_SPIRV_TOOLS_DIR="$work/spirv-tools-shaderc"
cmake --build "$shaderc/build" --target shaderc_combined shaderc_combined-pkg-config -j "$jobs"
cp -R "$shaderc/libshaderc/include/shaderc" "$prefix/include/"
cp "$shaderc/build/libshaderc/libshaderc_combined.a" "$prefix/lib/"
cp "$shaderc/build/shaderc_combined.pc" "$prefix/lib/pkgconfig/"

spirv_cross="$work/spirv-cross-1.4.321"
cmake -S "$spirv_cross" -B "$spirv_cross/build" -G Ninja \
  -DCMAKE_TOOLCHAIN_FILE="$work/cross.cmake" -DCMAKE_INSTALL_PREFIX="$prefix" \
  -DCMAKE_INSTALL_LIBDIR=lib -DCMAKE_BUILD_TYPE=MinSizeRel \
  -DSPIRV_CROSS_SHARED=OFF -DSPIRV_CROSS_CLI=OFF -DSPIRV_CROSS_ENABLE_TESTS=OFF \
  -DSPIRV_CROSS_ENABLE_CPP=OFF -DSPIRV_CROSS_ENABLE_MSL=OFF \
  -DSPIRV_CROSS_ENABLE_REFLECT=OFF -DSPIRV_CROSS_ENABLE_UTIL=OFF
cmake --build "$spirv_cross/build" -j "$jobs"
cmake --install "$spirv_cross/build"
# The installed pkg-config file lists only the C API archive.
sed -i '/^Libs:/ s/$/ -lspirv-cross-hlsl -lspirv-cross-glsl -lspirv-cross-core/' \
  "$prefix/lib/pkgconfig/spirv-cross-c.pc"

(
  cd "$work/ffmpeg-8.1"
  ./configure --prefix="$prefix" --target-os=mingw32 --arch=x86_64 --enable-cross-compile \
    --cross-prefix="$target-" --cc="$target-gcc-posix" --pkg-config=pkg-config \
    --pkg-config-flags=--static --extra-cflags="-I$prefix/include" --extra-ldflags=-static \
    --disable-autodetect --disable-everything --disable-programs --disable-doc \
    --disable-debug --disable-avdevice --enable-static --enable-small --enable-network \
    --enable-schannel --enable-libxml2 --enable-d3d11va --enable-w32threads \
    --enable-demuxer=mov,hls,dash,mpegts,matroska,aac,mp3,webvtt,srt,ass,wav,ogg,flac,yuv4mpegpipe \
    --enable-protocol=file,http,https,tls,tcp,crypto,data,httpproxy \
    --enable-decoder=h264,hevc,av1,vp8,vp9,mpeg4,aac,aac_latm,mp3,ac3,eac3,opus,vorbis,flac,alac,pcm_s16le,pcm_s24le,pcm_f32le,ass,subrip,webvtt,rawvideo \
    --enable-parser=h264,hevc,av1,vp8,vp9,mpeg4video,aac,aac_latm,ac3,mpegaudio,opus \
    --enable-hwaccel=h264_d3d11va,h264_d3d11va2,hevc_d3d11va,hevc_d3d11va2,av1_d3d11va,av1_d3d11va2,vp9_d3d11va,vp9_d3d11va2 \
    --enable-filter=buffer,buffersink,abuffer,abuffersink,format,aformat,aresample,atempo,scale,volume \
    --enable-encoder=mjpeg --enable-muxer=spdif
  make -j "$jobs"
  make install
)

# Use the static shader libraries and link the MinGW C++ runtime statically.
python3 - "$work/mpv-0.42.0/meson.build" <<'PYTHON'
from pathlib import Path
import sys

path = Path(sys.argv[1])
source = path.read_text()
patches = {
    "dependency('shaderc',": "dependency('shaderc_combined',",
    "dependency('spirv-cross-c-shared',": "dependency('spirv-cross-c',",
    "cc = meson.get_compiler('c')":
        "cc = meson.get_compiler('c')\ndependencies += cc.find_library('stdc++', static: true)",
}
for old, new in patches.items():
    if source.count(old) != 1:
        raise RuntimeError(f"mpv build patch no longer applies: {old}")
    source = source.replace(old, new)
path.write_text(source)
PYTHON

build mpv-0.42.0 shared -Dgpl=false -Dcplayer=false -Dlibmpv=true \
  -Dbuild-date=false -Dlua=disabled -Dwasapi=enabled -Dd3d-hwaccel=enabled \
  -Dgl=disabled -Dd3d11=enabled -Dshaderc=enabled -Dspirv-cross=enabled \
  -Dwin32-threads=enabled -Dvector=enabled

cp "$prefix/bin/libmpv-2.dll" "$output/"
cp "$work/mpv-0.42.0/LICENSE.LGPL" "$output/"
{
  echo 'YummyWatch Windows x64 LGPL libmpv build'
  echo 'Video renderer: D3D11'
  echo 'Recipe: https://github.com/vicimpa/yummywatch/blob/main/packaging/windows/build-libmpv.sh'
  cat "$sources"
  echo
  echo 'Build recipe used for this binary:'
  cat "$0"
  for license in \
    mpv-0.42.0/Copyright ffmpeg-8.1/COPYING.LGPLv2.1 libplacebo-7.387.0/LICENSE \
    libass-0.17.4/COPYING freetype-2.14.1/docs/FTL.TXT fribidi-1.0.16/COPYING \
    harfbuzz-12.1.0/COPYING fast_float-8.1.0/LICENSE-MIT \
    vulkan-headers-1.4.321/LICENSE.md libxml2-2.15.4/Copyright shaderc-2025.5/LICENSE \
    glslang-shaderc/LICENSE.txt spirv-headers-shaderc/LICENSE spirv-tools-shaderc/LICENSE \
    spirv-cross-1.4.321/LICENSE; do
    echo
    echo "$license"
    cat "$work/$license"
  done
} > "$output/SOURCE.txt"
(
  cd "$output"
  sha256sum libmpv-2.dll LICENSE.LGPL SOURCE.txt > SHA256SUMS.txt
  ls -lh libmpv-2.dll
)
