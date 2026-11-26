// FFmpegShim.m — 让 FFmpegShim 成为「编译型静态 pod」（CocoaPods 据此生成可被依赖框架 import 的 module）。
// 本体是伞头 FFmpegShim.h（#include 全部 FFmpeg 公共头），这里仅 import 一次以确保目标有编译产物。
#import "FFmpegShim.h"
