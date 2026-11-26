// FFmpegShim.m — 用 FFmpeg C API 实现 demux + 软解 + swscale/swresample，封装成对 Swift 友好的简单 API。
#import "FFmpegShim.h"
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

struct FFPlayer {
    int64_t endOf;
    ff_read_fn reader;
    void *readerOpaque;
    int64_t curOffset;
    unsigned char *ioBuf;
    int ioBufSize;
    AVIOContext *io;
    AVFormatContext *fmt;
    AVCodecContext *vdec;
    AVCodecContext *adec;
    int vidx;
    int aidx;
    AVRational vtb;
    double duration;
    SwsContext *sws;
    SwrContext *swr;
    AVPacket *pkt;
    AVFrame *frame;
};

static int ff_read_cb(void *opaque, uint8_t *buf, int size) {
    struct FFPlayer *p = (struct FFPlayer *)opaque;
    int n = p->reader(p->readerOpaque, p->curOffset, buf, size);
    if (n > 0) p->curOffset += n;
    return n; // 0 或负 = EOF
}
static int64_t ff_seek_cb(void *opaque, int64_t off, int whence) {
    struct FFPlayer *p = (struct FFPlayer *)opaque;
    int64_t base = 0;
    if (whence == AVSEEK_SET) base = 0;
    else if (whence == AVSEEK_CUR) base = p->curOffset;
    else base = p->endOf;
    p->curOffset = base + off;
    return p->curOffset;
}

FFPlayer *ff_player_new(int64_t endOf, ff_read_fn reader, void *readerOpaque) {
    struct FFPlayer *p = (struct FFPlayer *)calloc(1, sizeof(struct FFPlayer));
    p->endOf = endOf; p->reader = reader; p->readerOpaque = readerOpaque;
    return p;
}

void ff_player_free(FFPlayer *p) {
    if (!p) return;
    if (p->pkt) av_packet_free(&p->pkt);
    if (p->frame) av_frame_free(&p->frame);
    if (p->sws) sws_freeContext(p->sws);
    if (p->swr) swr_free(&p->swr);
    if (p->vdec) avcodec_free_context(&p->vdec);
    if (p->adec) avcodec_free_context(&p->adec);
    if (p->fmt) avformat_close_input(&p->fmt);
    if (p->io) avio_context_free(&p->io);
    if (p->ioBuf) av_freep(&p->ioBuf);
    free(p);
}

int ff_player_open(FFPlayer *p) {
    p->ioBufSize = 65536;
    p->ioBuf = (unsigned char *)av_malloc(p->ioBufSize);
    p->io = avio_alloc_context(p->ioBuf, p->ioBufSize, 0, p, ff_read_cb, NULL, ff_seek_cb);
    if (!p->io) return -1;
    p->fmt = avformat_alloc_context();
    if (!p->fmt) return -1;
    p->fmt->pb = p->io;
    int rc = avformat_open_input(&p->fmt, "", NULL, NULL);
    if (rc < 0) return rc;
    rc = avformat_find_stream_info(p->fmt, NULL);
    if (rc < 0) return rc;
    int64_t dur = p->fmt->duration;
    p->duration = (dur > 0) ? (double)dur * av_q2d(p->fmt->time_base) : 0.0;
    p->vidx = av_find_best_stream(p->fmt, AVMEDIA_TYPE_VIDEO, -1, -1, &p->vdec, 0);
    p->aidx = av_find_best_stream(p->fmt, AVMEDIA_TYPE_AUDIO, -1, -1, &p->adec, 0);
    if (p->vidx < 0 || !p->vdec) return -1;
    AVStream *vs = avformat_get_stream(p->fmt, p->vidx);
    p->vtb = vs->time_base;
    const AVCodec *vc = avcodec_find_decoder(vs->codecpar->codec_id);
    if (!vc || avcodec_open2(p->vdec, vc, NULL) < 0) return -1;
    if (p->aidx >= 0 && p->adec) {
        AVStream *as = avformat_get_stream(p->fmt, p->aidx);
        const AVCodec *ac = avcodec_find_decoder(as->codecpar->codec_id);
        if (!ac || avcodec_open2(p->adec, ac, NULL) < 0) { avcodec_free_context(&p->adec); p->adec = NULL; }
    }
    p->pkt = av_packet_alloc();
    p->frame = av_frame_alloc();
    return 0;
}

double ff_player_duration(FFPlayer *p) { return p->duration; }
int ff_player_video_w(FFPlayer *p) { return p->vdec ? p->vdec->width : 0; }
int ff_player_video_h(FFPlayer *p) { return p->vdec ? p->vdec->height : 0; }

int ff_player_next(FFPlayer *p) {
    while (1) {
        int rc = av_read_frame(p->fmt, p->pkt);
        if (rc < 0) return 0; // EOF
        int si = p->pkt->stream_index;
        AVCodecContext *dec = NULL;
        if (si == p->vidx && p->vdec) dec = p->vdec;
        else if (si == p->aidx && p->adec) dec = p->adec;
        if (!dec) { av_packet_unref(p->pkt); continue; }
        avcodec_send_packet(dec, p->pkt);
        av_packet_unref(p->pkt);
        int got = avcodec_receive_frame(dec, p->frame);
        if (got == 0) return (si == p->vidx) ? 1 : 2;
        // EAGAIN：需要更多包，继续读
    }
}

double ff_player_video_bgra(FFPlayer *p, uint8_t *out, int outCap) {
    AVFrame *f = p->frame;
    if (!f || !p->vdec) return -1;
    int w = p->vdec->width, h = p->vdec->height;
    if (w * h * 4 > outCap) return -1;
    if (!p->sws) {
        p->sws = sws_getContext(w, h, (AVPixelFormat)f->format, w, h, AV_PIX_FMT_BGRA, SWS_BILINEAR, NULL, NULL, NULL);
        if (!p->sws) return -1;
    }
    uint8_t *dst[4] = { out, NULL, NULL, NULL };
    int dstStride[4] = { w * 4, 0, 0, 0 };
    sws_scale(p->sws, (const uint8_t * const *)f->data, f->linesize, 0, h, dst, dstStride);
    double pts = (f->best_effort_timestamp >= 0) ? av_q2d(p->vtb) * f->best_effort_timestamp : 0.0;
    return pts;
}

int ff_player_audio_float(FFPlayer *p, float *outL, float *outR, int outCap) {
    AVFrame *f = p->frame;
    if (!f || !p->adec) return 0;
    if (!p->swr) {
        AVChannelLayout inLay, outLay;
        int inCh = p->adec->ch_layout.nb_channels > 0 ? p->adec->ch_layout.nb_channels : p->adec->channels;
        av_channel_layout_default(&inLay, inCh > 0 ? inCh : 2);
        av_channel_layout_default(&outLay, 2);
        p->swr = swr_alloc_set_opts2(&outLay, AV_SAMPLE_FMT_FLTP, 48000, &inLay, (AVSampleFormat)f->format, p->adec->sample_rate, 0, NULL);
        av_channel_layout_uninit(&inLay);
        av_channel_layout_uninit(&outLay);
        if (!p->swr || swr_init(p->swr) < 0) return 0;
    }
    uint8_t *planes[2] = { (uint8_t *)outL, (uint8_t *)outR };
    int converted = swr_convert(p->swr, planes, outCap, (const uint8_t * const *)f->data, f->nb_samples);
    return converted > 0 ? converted : 0;
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

void ff_player_seek(FFPlayer *p, double seconds) {
    if (!p->fmt || !p->vdec) return;
    int64_t target = (int64_t)(seconds / av_q2d(p->vtb));
    av_seek_frame(p->fmt, p->vidx, target, AVSEEK_FLAG_BACKWARD);
    avcodec_flush_buffers(p->vdec);
    if (p->adec) avcodec_flush_buffers(p->adec);
}
