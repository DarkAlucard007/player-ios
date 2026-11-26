// FFmpegShim.h — 伞头：把 FFmpeg C API 暴露给 Swift（经 CocoaPods 生成的 FFmpegShim module）。
// FFmpeg 公共头由 CI 拷到 media-plugin/FFmpegShim/include/，且 workflow 用 sed 把 podspec 的
// HEADER_SEARCH_PATHS 写成该目录的绝对路径。用「尖括号包含」走搜索路径（引号包含会相对编译时
// 伞头所在 Pods/Headers 目录解析，那里没有 FFmpeg 头，故不用引号）。FFmpeg 头不进 source_files
// （不作为 module 成员，避免 cyclic dependency）。
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
