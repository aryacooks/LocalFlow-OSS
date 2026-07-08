#include <include/whisper.h>
#include <ggml/include/ggml.h>

#ifdef GGML_USE_VULKAN
#include "ggml-vulkan.h"
#endif

// Force build script rerun to copy updated bindings.rs
