// FFmpegShim.h — exposes the FFmpeg C API to Swift via the modulemap.
// The FFmpeg public headers live in ../ffmpeg/include (built by CI).
#ifndef FFMPEG_SHIM_H
#define FFMPEG_SHIM_H

#include <libavutil/avutil.h>
#include <libavutil/opt.h>
#include <libavutil/imgutils.h>
#include <libavutil/pixfmt.h>
#include <libavutil/channel_layout.h>
#include <libavutil/samplefmt.h>
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libswscale/swscale.h>
#include <libswresample/swresample.h>

// 自定义 AVIO：把 AVIOContext 挂到 AVFormatContext.pb 上（Swift 侧 AVFormatContext 不透明，需 C 助手）
static inline void ff_format_set_pb(AVFormatContext *fmt, AVIOContext *pb) { fmt->pb = pb; }

#endif // FFMPEG_SHIM_H
