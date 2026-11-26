// FFmpegShim.m — FFmpeg C API 实现 demux + 软解 + swscale/swresample，封装成对 Swift 友好的简单 API。
// 用 struct 标签 + 直接 streams[] 访问 + 手动宏兜底，不依赖 typedef/新 API 是否可见。
#import "FFmpegShim.h"
#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>
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
#include <stdlib.h>
#include <string.h>

#ifndef AVSEEK_SET
#define AVSEEK_SET 0
#endif
#ifndef AVSEEK_CUR
#define AVSEEK_CUR 1
#endif
#ifndef AVSEEK_END
#define AVSEEK_END 2
#endif
#ifndef AVSEEK_FLAG_BACKWARD
#define AVSEEK_FLAG_BACKWARD 1
#endif

typedef struct SwsContext SwsContext;
typedef struct SwrContext SwrContext;

struct FFPlayer {
    int64_t endOf;
    ff_read_fn reader;
    void *readerOpaque;
    int64_t curOffset;
    unsigned char *ioBuf;
    int ioBufSize;
    struct AVIOContext *io;
    struct AVFormatContext *fmt;
    struct AVCodecContext *vdec;
    struct AVCodecContext *adec;
    int vidx;
    int aidx;
    struct AVRational vtb;
    double duration;
    SwsContext *sws;
    SwrContext *swr;
    struct AVPacket *pkt;
    struct AVFrame *frame;
};

static int ff_read_cb(void *opaque, uint8_t *buf, int bufSize) {
    struct FFPlayer *p = (struct FFPlayer *)opaque;
    if (!p->reader || p->curOffset >= p->endOf) return -1;
    int n = p->reader(p->readerOpaque, p->curOffset, buf, bufSize);
    if (n <= 0) return -1;
    p->curOffset += n;
    return n;
}
static int64_t ff_seek_cb(void *opaque, int64_t off, int whence) {
    struct FFPlayer *p = (struct FFPlayer *)opaque;
    int64_t base = 0;
    if (whence == AVSEEK_SET) base = 0;
    else if (whence == AVSEEK_CUR) base = p->curOffset;
    else base = p->endOf;
    p->curOffset = base + off;
    if (p->curOffset < 0) p->curOffset = 0;
    return p->curOffset;
}

static inline struct AVStream *vid_stream(struct FFPlayer *p) { return p->fmt->streams[p->vidx]; }
static inline struct AVStream *aud_stream(struct FFPlayer *p) { return p->aidx >= 0 ? p->fmt->streams[p->aidx] : NULL; }

FFPlayer *ff_player_new(int64_t endOf, ff_read_fn reader, void *readerOpaque) {
    struct FFPlayer *p = (struct FFPlayer *)calloc(1, sizeof(struct FFPlayer));
    if (!p) return NULL;
    p->endOf = endOf;
    p->reader = reader;
    p->readerOpaque = readerOpaque;
    p->ioBufSize = 65536;
    p->ioBuf = (unsigned char *)av_malloc(p->ioBufSize);
    p->vidx = -1;
    p->aidx = -1;
    return p;
}
void ff_player_free(FFPlayer *p) {
    if (!p) return;
    if (p->sws) sws_freeContext(p->sws);
    if (p->swr) swr_free(&p->swr);
    if (p->vdec) avcodec_free_context(&p->vdec);
    if (p->adec) avcodec_free_context(&p->adec);
    if (p->pkt) av_packet_free(&p->pkt);
    if (p->frame) av_frame_free(&p->frame);
    if (p->io) avio_context_free(&p->io);
    if (p->fmt) avformat_close_input(&p->fmt);
    if (p->ioBuf) av_free(p->ioBuf);
    free(p);
}
int ff_player_open(FFPlayer *p) {
    if (!p) return -1;
    p->io = avio_alloc_context(p->ioBuf, p->ioBufSize, 0, p, ff_read_cb, NULL, ff_seek_cb);
    if (!p->io) return -2;
    p->fmt = avformat_alloc_context();
    if (!p->fmt) return -3;
    p->fmt->pb = p->io;
    int rc = avformat_open_input(&p->fmt, "", NULL, NULL);
    if (rc < 0) { p->fmt->pb = NULL; return rc; }
    rc = avformat_find_stream_info(p->fmt, NULL);
    if (rc < 0) return rc;
    int64_t dur = p->fmt->duration;
    p->duration = dur > 0 ? dur / 1000000.0 : 0;
    p->vidx = av_find_best_stream(p->fmt, AVMEDIA_TYPE_VIDEO, -1, -1, &p->vdec, 0);
    p->aidx = av_find_best_stream(p->fmt, AVMEDIA_TYPE_AUDIO, -1, -1, &p->adec, 0);
    if (p->vidx < 0 || !p->vdec) return -10;
    p->pkt = av_packet_alloc();
    p->frame = av_frame_alloc();
    struct AVStream *vs = vid_stream(p);
    if (vs && vs->codecpar) {
        const struct AVCodec *vc = avcodec_find_decoder(vs->codecpar->codec_id);
        if (!vc) return -11;
        rc = avcodec_open2(p->vdec, vc, NULL);
        if (rc < 0) return rc;
        p->vtb = vs->time_base;
    }
    if (p->aidx >= 0 && p->adec) {
        struct AVStream *as = aud_stream(p);
        if (as && as->codecpar) {
            const struct AVCodec *ac = avcodec_find_decoder(as->codecpar->codec_id);
            if (ac) avcodec_open2(p->adec, ac, NULL);
        }
    }
    return 0;
}
double ff_player_duration(FFPlayer *p) { return p ? p->duration : 0; }
int ff_player_video_w(FFPlayer *p) {
    if (!p || !p->vdec) return 0;
    struct AVStream *vs = vid_stream(p);
    return (vs && vs->codecpar) ? vs->codecpar->width : p->vdec->width;
}
int ff_player_video_h(FFPlayer *p) {
    if (!p || !p->vdec) return 0;
    struct AVStream *vs = vid_stream(p);
    return (vs && vs->codecpar) ? vs->codecpar->height : p->vdec->height;
}
int ff_player_next(FFPlayer *p) {
    if (!p || !p->fmt) return -1;
    while (1) {
        int rc = av_read_frame(p->fmt, p->pkt);
        if (rc < 0) return 0; // EOF 或错误
        int idx = p->pkt->stream_index;
        if (idx == p->vidx && p->vdec) {
            avcodec_send_packet(p->vdec, p->pkt);
            if (avcodec_receive_frame(p->vdec, p->frame) == 0) { av_packet_unref(p->pkt); return 1; }
        } else if (idx == p->aidx && p->adec) {
            avcodec_send_packet(p->adec, p->pkt);
            if (avcodec_receive_frame(p->adec, p->frame) == 0) { av_packet_unref(p->pkt); return 2; }
        }
        av_packet_unref(p->pkt);
    }
}
double ff_player_video_bgra(FFPlayer *p, uint8_t *out, int outCap) {
    struct AVFrame *f = p->frame;
    if (!p || !p->vdec || !f || !out) return -1;
    int w = ff_player_video_w(p), h = ff_player_video_h(p);
    if (w <= 0 || h <= 0) return -1;
    if (!p->sws) {
        p->sws = sws_getContext(w, h, (enum AVPixelFormat)f->format, w, h, AV_PIX_FMT_BGRA, SWS_BILINEAR, NULL, NULL, NULL);
        if (!p->sws) return -2;
    }
    int dstStride = w * 4;
    uint8_t *dst[4] = { out, NULL, NULL, NULL };
    int strides[4] = { dstStride, 0, 0, 0 };
    sws_scale(p->sws, (const uint8_t * const *)f->data, (const int *)f->linesize, 0, h, dst, strides);
    int64_t ts = f->best_effort_timestamp;
    double pts = ts >= 0 ? av_q2d(p->vtb) * ts : -1;
    return pts;
}
int ff_player_audio_float(FFPlayer *p, float *outL, float *outR, int outCap) {
    struct AVFrame *f = p->frame;
    if (!p || !p->adec || !f || !outL || !outR) return 0;
    if (!p->swr) {
        enum AVSampleFormat inFmt = (enum AVSampleFormat)f->format;
        int inRate = p->adec->sample_rate;
        AVChannelLayout inLay, outLay;
        int inCh = p->adec->ch_layout.nb_channels > 0 ? (int)p->adec->ch_layout.nb_channels : p->adec->channels;
        av_channel_layout_default(&inLay, inCh > 0 ? inCh : 2);
        av_channel_layout_default(&outLay, 2);
        p->swr = swr_alloc_set_opts2(&outLay, AV_SAMPLE_FMT_FLTP, 48000, &inLay, inFmt, inRate, 0, NULL);
        av_channel_layout_uninit(&inLay);
        av_channel_layout_uninit(&outLay);
        if (!p->swr || swr_init(p->swr) < 0) return 0;
    }
    uint8_t *planes[2] = { (uint8_t *)outL, (uint8_t *)outR };
    int converted = swr_convert(p->swr, planes, outCap, (const uint8_t * const *)f->data, f->nb_samples);
    return converted > 0 ? converted : 0;
}
void ff_player_seek(FFPlayer *p, double seconds) {
    if (!p || !p->fmt || p->vidx < 0) return;
    struct AVStream *vs = vid_stream(p);
    if (!vs) return;
    int64_t target = (int64_t)(seconds / av_q2d(vs->time_base));
    av_seek_frame(p->fmt, p->vidx, target, AVSEEK_FLAG_BACKWARD);
    if (p->vdec) avcodec_flush_buffers(p->vdec);
    if (p->adec) avcodec_flush_buffers(p->adec);
    p->curOffset = 0;
}
CMSampleBufferRef ff_player_make_cmsample(CVPixelBufferRef pb, double pts, double dur) {
    CMSampleTimingInfo timing;
    timing.duration = CMTimeMakeScale((int64_t)(dur * 90000), 90000);
    timing.presentationTimeStamp = CMTimeMakeScale((int64_t)(pts * 90000), 90000);
    timing.decodeTimeStamp = kCMTimeInvalid;
    CMSampleBufferRef sb = NULL;
    OSStatus st = CMSampleBufferCreateForImageBuffer(NULL, pb, true, NULL, NULL, NULL, &timing, &sb);
    return st == noErr ? sb : NULL;
}
