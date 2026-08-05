/*
 * nt_http.c — HTTP(S) client primitive for nativets (networking tier, L-d).
 *
 * Backed by libcurl (which brings its own TLS), exposed to codegen as two flat
 * scalar-ABI functions:
 *
 *   const char *nt_http_post(url, headers, body, double *status_out)
 *   const char *nt_http_get (url, headers,       double *status_out)
 *
 * Both return the response body as a NUL-terminated, rc-registered heap string
 * (so it participates in the runtime's string reclamation exactly like readLine's
 * result) and write the numeric HTTP status into *status_out (a `double`, since
 * every nativets number is an IEEE-754 double). Codegen packs the pair into a
 * `{status:number,body:string}` object.
 *
 * `headers` is a newline-joined list of `Name: Value` lines (empty ⇒ none).
 *
 * PORTABILITY: this is HOST/LINUX ONLY. libcurl is present on macOS/Linux CI
 * runners; iOS/Android would use the platform HTTP stack (NSURLSession/OkHttp),
 * a follow-on. This file is compiled + linked (with -lcurl) ONLY when a program
 * actually uses httpGet/httpPost, so non-HTTP programs — and their iOS/Android
 * cross-builds — are entirely unaffected (see driver.ts conditional link).
 *
 * Additive & self-contained: it only forward-declares the two runtime.c symbols
 * it needs (nativets_alloc / nt_str_register); runtime.c is untouched.
 */

#include <curl/curl.h>
#include <stdlib.h>
#include <string.h>
#include <stddef.h>

/* Provided by runtime.c (linked together). */
extern void *nativets_alloc(size_t n);
extern void  nt_str_register(void *p);

typedef struct { char *buf; size_t len; size_t cap; } HttpBuf;

/* libcurl write callback: append received bytes into a growable buffer. */
static size_t http_write(void *ptr, size_t size, size_t nmemb, void *userdata) {
  size_t n = size * nmemb;
  HttpBuf *b = (HttpBuf *)userdata;
  if (b->len + n + 1 > b->cap) {
    size_t nc = b->cap ? b->cap : 256;
    while (b->len + n + 1 > nc) nc *= 2;
    char *nb = (char *)realloc(b->buf, nc);
    if (!nb) return 0; /* signal error to curl */
    b->buf = nb; b->cap = nc;
  }
  memcpy(b->buf + b->len, ptr, n);
  b->len += n;
  return n;
}

/* Move the accumulated bytes into an rc-registered runtime string; free scratch. */
static const char *http_finish(HttpBuf *b) {
  char *s = (char *)nativets_alloc(b->len + 1);
  if (b->len) memcpy(s, b->buf, b->len);
  s[b->len] = '\0';
  nt_str_register(s);
  free(b->buf);
  return s;
}

/* Split a newline-joined header string into a curl_slist ("Name: Value" lines). */
static struct curl_slist *http_headers(const char *headers) {
  struct curl_slist *list = NULL;
  if (!headers) return NULL;
  const char *p = headers;
  while (*p) {
    const char *nl = strchr(p, '\n');
    size_t len = nl ? (size_t)(nl - p) : strlen(p);
    if (len > 0) {                    /* skip blank lines */
      char *line = (char *)malloc(len + 1);
      memcpy(line, p, len); line[len] = '\0';
      list = curl_slist_append(list, line);
      free(line);
    }
    if (!nl) break;
    p = nl + 1;
  }
  return list;
}

static const char *http_do(const char *url, const char *headers, const char *body,
                           int is_post, double *status_out) {
  HttpBuf b = { NULL, 0, 0 };
  long status = 0;
  CURL *c = curl_easy_init();
  if (c) {
    struct curl_slist *hs = http_headers(headers);
    curl_easy_setopt(c, CURLOPT_URL, url);
    if (hs) curl_easy_setopt(c, CURLOPT_HTTPHEADER, hs);
    if (is_post) {
      const char *b2 = body ? body : "";
      curl_easy_setopt(c, CURLOPT_POST, 1L);
      curl_easy_setopt(c, CURLOPT_POSTFIELDS, b2);
      curl_easy_setopt(c, CURLOPT_POSTFIELDSIZE, (long)strlen(b2));
    }
    curl_easy_setopt(c, CURLOPT_WRITEFUNCTION, http_write);
    curl_easy_setopt(c, CURLOPT_WRITEDATA, &b);
    curl_easy_setopt(c, CURLOPT_FOLLOWLOCATION, 1L);
    curl_easy_setopt(c, CURLOPT_USERAGENT, "nativets/0.1");
    if (curl_easy_perform(c) == CURLE_OK)
      curl_easy_getinfo(c, CURLINFO_RESPONSE_CODE, &status); /* else status stays 0 */
    if (hs) curl_slist_free_all(hs);
    curl_easy_cleanup(c);
  }
  if (status_out) *status_out = (double)status;
  return http_finish(&b);
}

const char *nt_http_post(const char *url, const char *headers, const char *body, double *status_out) {
  return http_do(url, headers, body, 1, status_out);
}

const char *nt_http_get(const char *url, const char *headers, double *status_out) {
  return http_do(url, headers, NULL, 0, status_out);
}

/* ============================================================================
 * fetch — the web-standard client on top of the same libcurl core.
 *
 * `nt_fetch` performs a BLOCKING request (nativets has no event loop; `await` is an
 * identity pass-through — see docs/divergences.md) and fills in the three slots of
 * the codegen-allocated Response block:
 *   *status_out   the numeric HTTP status (a `double`, like every nativets number)
 *   *headers_out  the RAW response header block (for case-insensitive `.get`)
 *   return value  the response body
 * Both strings are rc-registered heap strings, exactly like httpGet's body.
 *
 * A transport failure (DNS, connection refused, TLS) RAISES a catchable throw via the
 * pending-exception protocol, so `try { await fetch(u) } catch (e) { … }` behaves like
 * node's fetch rejecting — never a silent status-0 Response.
 * ========================================================================= */

/* Provided by runtime.c — raise a catchable exception (pending-flag protocol). */
extern void nt_exc_raise_msg(const char *msg);

const char *nt_fetch(const char *url, const char *method, const char *headers,
                     const char *body, double *status_out, const char **headers_out) {
  HttpBuf b = { NULL, 0, 0 }, h = { NULL, 0, 0 };
  long status = 0;
  int ok = 0;
  CURL *c = curl_easy_init();
  if (c) {
    struct curl_slist *hs = http_headers(headers);
    curl_easy_setopt(c, CURLOPT_URL, url);
    if (hs) curl_easy_setopt(c, CURLOPT_HTTPHEADER, hs);
    /* Any method other than GET carries a (possibly empty) request body, exactly like
     * `fetch(url, { method, body })`. CUSTOMREQUEST covers POST/PUT/PATCH/DELETE. */
    if (method && *method && strcmp(method, "GET") != 0) {
      const char *b2 = body ? body : "";
      curl_easy_setopt(c, CURLOPT_POSTFIELDS, b2);
      curl_easy_setopt(c, CURLOPT_POSTFIELDSIZE, (long)strlen(b2));
      curl_easy_setopt(c, CURLOPT_CUSTOMREQUEST, method);
    }
    curl_easy_setopt(c, CURLOPT_WRITEFUNCTION, http_write);
    curl_easy_setopt(c, CURLOPT_WRITEDATA, &b);
    curl_easy_setopt(c, CURLOPT_HEADERFUNCTION, http_write); /* same appender */
    curl_easy_setopt(c, CURLOPT_HEADERDATA, &h);
    curl_easy_setopt(c, CURLOPT_FOLLOWLOCATION, 1L);
    curl_easy_setopt(c, CURLOPT_USERAGENT, "nativets/0.1");
    if (curl_easy_perform(c) == CURLE_OK) {
      ok = 1;
      curl_easy_getinfo(c, CURLINFO_RESPONSE_CODE, &status);
    }
    if (hs) curl_slist_free_all(hs);
    curl_easy_cleanup(c);
  }
  if (status_out) *status_out = (double)status;
  if (headers_out) *headers_out = http_finish(&h);
  else free(h.buf);
  const char *resp = http_finish(&b);
  if (!ok) nt_exc_raise_msg("TypeError: fetch failed"); /* node's fetch rejects here */
  return resp;
}

static int hdr_ci_eq(const char *a, size_t alen, const char *b) {
  size_t i = 0;
  for (; i < alen; i++) {
    unsigned char x = (unsigned char)a[i], y = (unsigned char)b[i];
    if (!y) return 0;
    if (x >= 'A' && x <= 'Z') x = (unsigned char)(x - 'A' + 'a');
    if (y >= 'A' && y <= 'Z') y = (unsigned char)(y - 'A' + 'a');
    if (x != y) return 0;
  }
  return b[i] == '\0';
}

/* Case-insensitive header lookup over the raw header block (`Headers#get`). Returns an
 * rc-registered value string, or NULL when absent (codegen turns that into `null`, the
 * same value node's `headers.get` returns). With redirects the block holds several
 * responses, so the LAST match — the final response's header — wins. */
const char *nt_headers_get(const char *raw, const char *name) {
  if (!raw || !name) return NULL;
  const char *found = NULL;
  size_t found_len = 0;
  const char *p = raw;
  while (*p) {
    const char *nl = strchr(p, '\n');
    size_t len = nl ? (size_t)(nl - p) : strlen(p);
    size_t l = len;
    while (l > 0 && (p[l - 1] == '\r' || p[l - 1] == ' ')) l--;   /* strip CR / trailing space */
    const char *colon = (const char *)memchr(p, ':', l);
    if (colon) {
      size_t klen = (size_t)(colon - p);
      if (hdr_ci_eq(p, klen, name)) {
        const char *v = colon + 1;
        while (v < p + l && (*v == ' ' || *v == '\t')) v++;
        found = v;
        found_len = (size_t)(p + l - v);
      }
    }
    if (!nl) break;
    p = nl + 1;
  }
  if (!found) return NULL;
  char *s = (char *)nativets_alloc(found_len + 1);
  memcpy(s, found, found_len);
  s[found_len] = '\0';
  nt_str_register(s);
  return s;
}
