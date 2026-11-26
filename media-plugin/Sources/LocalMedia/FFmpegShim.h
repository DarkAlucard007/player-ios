// FFmpegShim.h — 干净的对 Swift 友好的 C 播放引擎 API。
// 所有 FFmpeg C API 的繁琐交互（宏、accessor、指针类型）都封装在 FFmpegShim.m 里，
// Swift 侧只调这些简单函数，不直接 import FFmpeg 头。
#ifndef FFMPEG_SHIM_H
#define FFMPEG_SHIM_H
#include <stdint.h>

// 读字节回调：从 offset 读最多 size 字节到 buf，返回实际读取字节数（EOF 返回 0）。
typedef int (*ff_read_fn)(void *opaque, int64_t offset, uint8_t *buf, int size);

typedef struct FFPlayer FFPlayer;

FFPlayer *ff_player_new(int64_t endOf, ff_read_fn reader, void *readerOpaque);
void ff_player_free(FFPlayer *p);

// 解封装 + 找流 + 开解码器。返回 0 成功，<0 失败。
int ff_player_open(FFPlayer *p);
double ff_player_duration(FFPlayer *p);   // 秒
int ff_player_video_w(FFPlayer *p);
int ff_player_video_h(FFPlayer *p);

// 解下一帧。返回 1=有视频帧、2=有音频帧、0=EOF、<0=错误。
int ff_player_next(FFPlayer *p);
// 取当前视频帧为 BGRA（w*h*4 字节）拷到 out，返回 PTS（秒），失败返回 -1。
double ff_player_video_bgra(FFPlayer *p, uint8_t *out, int outCap);
// 取当前音频帧重采样为 float 立体声 48k，分别拷到 outL/outR（各 outCap 样本），返回每声道样本数。
int ff_player_audio_float(FFPlayer *p, float *outL, float *outR, int outCap);

// 跳到 seconds 秒。
void ff_player_seek(FFPlayer *p, double seconds);

#endif // FFMPEG_SHIM_H
