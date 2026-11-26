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

#endif // FFMPEG_SHIM_H
