// Whether the GPUs' FP16 tensor cores run at full rate. A CMP 100-210's are
// throttled by its firmware unless it was unlocked since boot (host/cmp-unlock.sh),
// and the unlock doesn't survive a reboot, so its images ask at every start.
// Times a dependent chain of HMMA instructions (wmma m16n16k16, PTX that
// libcuda compiles itself, so no CUDA toolkit is needed) on each sm_70 GPU:
// about 37 cycles each at full rate, about 512 throttled. Prints "full", or
// "throttled" if any sm_70 GPU is; exits 1, printing nothing, if it can't tell.
// The same file is in host/llamacpp and host/sdcpp, each image's build context.
#include <dlfcn.h>
#include <stdint.h>
#include <stdio.h>

typedef int (*fn_t)();
#define REG8(p) p "0," p "1," p "2," p "3," p "4," p "5," p "6," p "7"
static const char PTX[] =
  ".version 6.3\n.target sm_70\n.address_size 64\n"
  ".visible .entry k(.param .u64 out, .param .u32 n) {\n"
  ".reg .b32 %a<8>; .reg .b32 %b<8>; .reg .f32 %d<8>; .reg .u64 %t0,%t1,%o; .reg .u32 %i,%n; .reg .pred %p;\n"
  "mov.b32 %a0,0x3c003c00; mov.b32 %a1,0x3c003c00; mov.b32 %a2,0x3c003c00; mov.b32 %a3,0x3c003c00;\n"
  "mov.b32 %a4,0x3c003c00; mov.b32 %a5,0x3c003c00; mov.b32 %a6,0x3c003c00; mov.b32 %a7,0x3c003c00;\n"
  "mov.b32 %b0,0x00010001; mov.b32 %b1,0x00010001; mov.b32 %b2,0x00010001; mov.b32 %b3,0x00010001;\n"
  "mov.b32 %b4,0x00010001; mov.b32 %b5,0x00010001; mov.b32 %b6,0x00010001; mov.b32 %b7,0x00010001;\n"
  "mov.f32 %d0,0f00000000; mov.f32 %d1,0f00000000; mov.f32 %d2,0f00000000; mov.f32 %d3,0f00000000;\n"
  "mov.f32 %d4,0f00000000; mov.f32 %d5,0f00000000; mov.f32 %d6,0f00000000; mov.f32 %d7,0f00000000;\n"
  "ld.param.u64 %o,[out]; ld.param.u32 %n,[n]; mov.u32 %i,0;\n"
  "mov.u64 %t0,%clock64;\n"
  "L: wmma.mma.sync.aligned.row.col.m16n16k16.f32.f32 {" REG8("%d") "},{" REG8("%a") "},{" REG8("%b") "},{" REG8("%d") "};\n"
  "add.u32 %i,%i,1; setp.lt.u32 %p,%i,%n; @%p bra L;\n"
  "mov.u64 %t1,%clock64; sub.u64 %t1,%t1,%t0; st.global.u64 [%o],%t1; st.global.f32 [%o+8],%d0;\n"
  "ret;\n}\n";

#define ITERS 20000
// Between the two: about 37 cycles unlocked, about 512 throttled.
#define THROTTLED_CYCLES 150

int main(void) {
  void *cu = dlopen("libcuda.so.1", RTLD_NOW);
  if (!cu) return 1;
  fn_t init = (fn_t)dlsym(cu, "cuInit"), count = (fn_t)dlsym(cu, "cuDeviceGetCount"), get = (fn_t)dlsym(cu, "cuDeviceGet"),
       attr = (fn_t)dlsym(cu, "cuDeviceGetAttribute"), ctxCreate = (fn_t)dlsym(cu, "cuCtxCreate_v2"), ctxDestroy = (fn_t)dlsym(cu, "cuCtxDestroy_v2"),
       load = (fn_t)dlsym(cu, "cuModuleLoadData"), func = (fn_t)dlsym(cu, "cuModuleGetFunction"), alloc = (fn_t)dlsym(cu, "cuMemAlloc_v2"),
       launch = (fn_t)dlsym(cu, "cuLaunchKernel"), sync = (fn_t)dlsym(cu, "cuCtxSynchronize"), copy = (fn_t)dlsym(cu, "cuMemcpyDtoH_v2");
  if (!init || !count || !get || !attr || !ctxCreate || !ctxDestroy || !load || !func || !alloc || !launch || !sync || !copy) return 1;
  int n = 0;
  if (init(0) || count(&n)) return 1;
  int throttled = 0;
  for (int i = 0; i < n; i++) {
    int dev, major = 0, minor = 0;
    // 75 and 76: CU_DEVICE_ATTRIBUTE_COMPUTE_CAPABILITY_MAJOR and _MINOR.
    if (get(&dev, i) || attr(&major, 75, dev) || attr(&minor, 76, dev)) return 1;
    if (major != 7 || minor != 0) continue;
    void *ctx, *mod, *fn;
    uint64_t buf, out[2] = {0, 0};
    if (ctxCreate(&ctx, 0, dev)) return 1;
    int bad = load(&mod, PTX) || func(&fn, mod, "k") || alloc(&buf, 16);
    for (int run = 0; !bad && run < 2; run++) {  // the first run warms up
      uint32_t iters = run ? ITERS : 1000;
      void *args[] = {&buf, &iters};
      bad = launch(fn, 1, 1, 1, 32, 1, 1, 0, NULL, args, NULL) || sync() || copy(out, buf, 16);
    }
    ctxDestroy(ctx);
    if (bad) return 1;
    if (out[0] / ITERS > THROTTLED_CYCLES) throttled = 1;
  }
  puts(throttled ? "throttled" : "full");
  return 0;
}
