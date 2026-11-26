// FFmpegShim.h — 伞头：把 FFmpeg C API 暴露给 Swift（经 CocoaPods 生成的 FFmpegShim module）。
// FFmpeg 公共头由 CI 拷到本目录 include/ 下（media-plugin/FFmpegShim/include/）。
// 用「引号包含」按相对本头文件位置解析——FFmpeg 头不进 source_files（不作为 module 成员，避免 cyclic dependency）。
#ifndef FFMPEG_SHIM_H
#define FFMPEG_SHIM_H

#include "include/libavutil/avutil.h"
#include "include/libavutil/opt.h"
#include "include/libavutil/imgutils.h"
#include "include/libavutil/pixfmt.h"
#include "include/libavutil/channel_layout.h"
#include "include/libavutil/samplefmt.h"
#include "include/libavcodec/avcodec.h"
#include "include/libavformat/avformat.h"
#include "include/libswscale/swscale.h"
#include "include/libswresample/swresample.h"

// 自定义 AVIO：把 AVIOContext 挂到 AVFormatContext.pb 上（Swift 侧 AVFormatContext 不透明，需 C 助手）
static inline void ff_format_set_pb(AVFormatContext *fmt, AVIOContext *pb) { fmt->pb = pb; }

#endif // FFMPEG_SHIM_H
