// Allocator stub behind WTF's FastMalloc (USE_BUN_MIMALLOC) for the measurements.
// Constant cost: mi_malloc is a pointer bump, mi_free does nothing. Both count their calls,
// so that a row reports instructions, allocations and frees from one run.
#include <stddef.h>
#include <string.h>
volatile unsigned long stub_mallocs, stub_frees, stub_bytes;
static char arena[1 << 28];
static size_t top;
static void* bump(size_t n)
{
    // 64-byte alignment: memcpy takes the same path for the same size in every build.
    size_t at = (top + 63) & ~(size_t)63;
    if (at + n > sizeof(arena))
        at = 0;
    top = at + n;
    stub_mallocs = stub_mallocs + 1;
    stub_bytes = stub_bytes + n;
    return arena + at;
}
void* mi_malloc(size_t n) { return bump(n); }
void* mi_zalloc(size_t n) { void* p = bump(n); memset(p, 0, n); return p; }
void* mi_calloc(size_t c, size_t n) { void* p = bump(c * n); memset(p, 0, c * n); return p; }
void* mi_realloc(void* p, size_t n) { void* q = bump(n); if (p) memcpy(q, p, n); return q; }
void mi_free(void* p) { if (p) stub_frees = stub_frees + 1; }
void* mi_malloc_aligned(size_t n, size_t a) { (void)a; return bump(n); }
void* mi_zalloc_aligned(size_t n, size_t a) { (void)a; void* p = bump(n); memset(p, 0, n); return p; }
void* mi_realloc_aligned(void* p, size_t n, size_t a) { (void)a; return mi_realloc(p, n); }
size_t mi_usable_size(const void* p) { (void)p; return 0; }
size_t mi_malloc_usable_size(const void* p) { (void)p; return 0; }
size_t mi_good_size(size_t n) { return n; }

// memcpy and memmove with a cost that depends on the size alone. The C library picks a path by the alignment of
// both pointers and by their distance, so the same copy costs a different number of instructions in two builds
// that allocate in a different order.
#if defined(__x86_64__)
void* memcpy(void* restrict d, const void* restrict s, size_t n)
{
    void* r = d;
    __asm__ volatile("rep movsb" : "+D"(d), "+S"(s), "+c"(n) : : "memory");
    return r;
}
void* memmove(void* d, const void* s, size_t n)
{
    void* r = d;
    if ((size_t)((const char*)d - (const char*)s) >= n) {
        __asm__ volatile("rep movsb" : "+D"(d), "+S"(s), "+c"(n) : : "memory");
        return r;
    }
    d = (char*)d + n - 1;
    s = (const char*)s + n - 1;
    __asm__ volatile("std; rep movsb; cld" : "+D"(d), "+S"(s), "+c"(n) : : "memory");
    return r;
}
#else
void* memcpy(void* restrict d, const void* restrict s, size_t n)
{
    char* dp = d;
    const char* sp = s;
    while (n--) {
        *dp++ = *sp++;
        __asm__ volatile("");
    }
    return d;
}
void* memmove(void* d, const void* s, size_t n)
{
    char* dp = d;
    const char* sp = s;
    if ((size_t)(dp - sp) >= n) {
        while (n--) {
            *dp++ = *sp++;
            __asm__ volatile("");
        }
        return d;
    }
    while (n--) {
        dp[n] = sp[n];
        __asm__ volatile("");
    }
    return d;
}
#endif
