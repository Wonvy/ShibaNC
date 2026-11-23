#ifndef SHIBANC_FFI_H
#define SHIBANC_FFI_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct ShibaRgbaBuffer {
    uint8_t *data;
    size_t len;
    uint32_t width;
    uint32_t height;
} ShibaRgbaBuffer;

bool shibanc_render_file_thumbnail(
    const char *path_utf8,
    uint32_t max_size,
    ShibaRgbaBuffer *out_buf
);

void shibanc_free_rgba_buffer(ShibaRgbaBuffer buf);

#ifdef __cplusplus
}
#endif

#endif // SHIBANC_FFI_H
