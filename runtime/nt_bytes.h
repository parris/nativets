/*
 * nt_bytes.h — byte-buffer value type for nativets stdlib batch 2 (bytes).
 *
 * Backs `Uint8Array` + `TextEncoder`/`TextDecoder` (UTF-8). Bytes are stored one
 * per byte (NOT the generic 8-byte-slot vector), so a Uint8Array is a compact
 * `uint8_t[]`. libc-only, so it cross-links unchanged; linked ONLY when a program
 * uses one of these builtins (see driver.ts, mirroring nt_mapset / nt_http).
 */
#ifndef NT_BYTES_H
#define NT_BYTES_H
#include <stdint.h>
#include <stddef.h>

typedef struct { int64_t len; uint8_t *data; } NtBytes;

NtBytes    *nt_bytes_new(double n);          /* zero-filled length n (n<0 -> 0)      */
NtBytes    *nt_bytes_from_arr(void *arr);    /* from an NtArray of numbers (ToUint8) */
double      nt_bytes_get(NtBytes *b, double i);           /* read 0..255 (double)     */
void        nt_bytes_set(NtBytes *b, double i, double v); /* write, JS ToUint8 wrap   */
double      nt_bytes_index(NtBytes *b, double i, const char *loc);            /* u[i], panics OOB */
void        nt_bytes_index_set(NtBytes *b, double i, double v, const char *loc); /* u[i]=v, panics OOB */
double      nt_bytes_len(NtBytes *b);
NtBytes    *nt_bytes_encode(const char *s);  /* TextEncoder: UTF-8 bytes of s        */
const char *nt_bytes_decode(NtBytes *b);     /* TextDecoder: bytes as UTF-8 string    */

#endif
