// N-API bindings for the instrument engine. N-API is ABI-stable, so the same
// build loads in plain Node (for tests) and in Electron without rebuilding.
#include <napi.h>

#include "engine.h"

namespace {

using resonant::Engine;

Engine& engine(const Napi::Env& env) { return *env.GetInstanceData<Engine>(); }

int optionalInt(const Napi::Object& object, const char* key, int fallback) {
  Napi::Value value = object.Get(key);
  return value.IsNumber() ? value.As<Napi::Number>().Int32Value() : fallback;
}

float optionalFloat(const Napi::Object& object, const char* key, float fallback) {
  Napi::Value value = object.Get(key);
  return value.IsNumber() ? value.As<Napi::Number>().FloatValue() : fallback;
}

Napi::Object infoObject(Napi::Env env, const resonant::EngineInfo& info) {
  Napi::Object result = Napi::Object::New(env);
  result.Set("inputUid", info.inputUid);
  result.Set("outputUid", info.outputUid);
  result.Set("inputName", info.inputName);
  result.Set("outputName", info.outputName);
  result.Set("split", info.split);
  result.Set("sampleRate", info.sampleRate);
  result.Set("bufferFrames", info.bufferFrames);
  result.Set("inputChannels", info.inputChannels);
  result.Set("outputChannels", info.outputChannels);
  result.Set("inputLatencyFrames", info.inputLatencyFrames);
  result.Set("outputLatencyFrames", info.outputLatencyFrames);
  result.Set("bridgeFrames", info.bridgeFrames);
  return result;
}

// Runs fn, turning C++ exceptions into JS errors
template <typename Fn>
Napi::Value guarded(const Napi::CallbackInfo& info, Fn fn) {
  try {
    return fn();
  } catch (const std::exception& error) {
    throw Napi::Error::New(info.Env(), error.what());
  }
}

Napi::Value ListDevices(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto devices = resonant::listDevices();
  Napi::Array result = Napi::Array::New(env, devices.size());
  for (size_t i = 0; i < devices.size(); i++) {
    const auto& device = devices[i];
    Napi::Object item = Napi::Object::New(env);
    item.Set("uid", device.uid);
    item.Set("name", device.name);
    item.Set("inputChannels", device.inputChannels);
    item.Set("outputChannels", device.outputChannels);
    item.Set("sampleRate", device.sampleRate);
    item.Set("clockDomain", device.clockDomain);
    item.Set("isDefaultInput", device.isDefaultInput);
    item.Set("isDefaultOutput", device.isDefaultOutput);
    result.Set(i, item);
  }
  return result;
}

// start({ inputUid, outputUid, bufferFrames = 64 }) → info.
// Pass the same uid twice for an interface that is one device in macOS.
Napi::Value Start(const Napi::CallbackInfo& info) {
  return guarded(info, [&]() -> Napi::Value {
    if (!info[0].IsObject()) throw std::runtime_error("start() needs an options object");
    Napi::Object options = info[0].As<Napi::Object>();
    if (!options.Get("inputUid").IsString() || !options.Get("outputUid").IsString()) {
      throw std::runtime_error("inputUid and outputUid are required");
    }
    std::string inputUid = options.Get("inputUid").As<Napi::String>();
    std::string outputUid = options.Get("outputUid").As<Napi::String>();
    engine(info.Env()).start(inputUid, outputUid, optionalInt(options, "bufferFrames", 64));
    return infoObject(info.Env(), engine(info.Env()).info());
  });
}

Napi::Value Stop(const Napi::CallbackInfo& info) {
  engine(info.Env()).stop();
  return info.Env().Undefined();
}

Napi::Value Info(const Napi::CallbackInfo& info) {
  Engine& e = engine(info.Env());
  return e.running() ? infoObject(info.Env(), e.info()) : info.Env().Null();
}

// stats() → { underruns, overruns, inputFrames, outputFrames, largest…Callback } since start
Napi::Value Stats(const Napi::CallbackInfo& info) {
  auto stats = engine(info.Env()).stats();
  Napi::Object result = Napi::Object::New(info.Env());
  result.Set("underruns", stats.underruns);
  result.Set("overruns", stats.overruns);
  result.Set("inputFrames", static_cast<double>(stats.inputFrames));
  result.Set("outputFrames", static_cast<double>(stats.outputFrames));
  result.Set("largestInputCallback", stats.largestInputCallback);
  result.Set("largestOutputCallback", stats.largestOutputCallback);
  return result;
}

// setTrack(index, { left, right = -1, gain = 1, pan = 0, monitor = true })
Napi::Value SetTrack(const Napi::CallbackInfo& info) {
  return guarded(info, [&]() -> Napi::Value {
    if (!info[0].IsNumber() || !info[1].IsObject()) throw std::runtime_error("setTrack(index, settings)");
    Napi::Object options = info[1].As<Napi::Object>();
    resonant::TrackSettings settings;
    settings.left = optionalInt(options, "left", -1);
    settings.right = optionalInt(options, "right", -1);
    settings.gain = optionalFloat(options, "gain", 1);
    settings.pan = optionalFloat(options, "pan", 0);
    Napi::Value monitor = options.Get("monitor");
    settings.monitor = monitor.IsBoolean() ? monitor.As<Napi::Boolean>().Value() : true;
    if (settings.left < 0) throw std::runtime_error("left input channel is required");
    engine(info.Env()).setTrack(info[0].As<Napi::Number>().Int32Value(), settings);
    return info.Env().Undefined();
  });
}

Napi::Value ClearTrack(const Napi::CallbackInfo& info) {
  return guarded(info, [&]() -> Napi::Value {
    if (!info[0].IsNumber()) throw std::runtime_error("clearTrack(index)");
    engine(info.Env()).clearTrack(info[0].As<Napi::Number>().Int32Value());
    return info.Env().Undefined();
  });
}

// takePeaks() → [{ index, left, right }] for active tracks, since the last call
Napi::Value TakePeaks(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Array result = Napi::Array::New(env);
  for (int i = 0; i < resonant::kMaxTracks; i++) {
    float left = 0, right = 0;
    engine(env).takePeaks(i, left, right);
    Napi::Object item = Napi::Object::New(env);
    item.Set("index", i);
    item.Set("left", left);
    item.Set("right", right);
    result.Set(result.Length(), item);
  }
  return result;
}

// takeInputPeaks() → [peak per input channel] since the last call
Napi::Value TakeInputPeaks(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto peaks = engine(env).takeInputPeaks();
  Napi::Array result = Napi::Array::New(env, peaks.size());
  for (size_t i = 0; i < peaks.size(); i++) result.Set(i, peaks[i]);
  return result;
}

// startLatencyTest({ outputChannel = 0, inputChannel = 0 })
Napi::Value StartLatencyTest(const Napi::CallbackInfo& info) {
  return guarded(info, [&]() -> Napi::Value {
    Napi::Object options = info[0].IsObject() ? info[0].As<Napi::Object>() : Napi::Object::New(info.Env());
    engine(info.Env()).startLatencyTest(optionalInt(options, "outputChannel", 0), optionalInt(options, "inputChannel", 0));
    return info.Env().Undefined();
  });
}

// latencyResult() → { state: 'idle' | 'running' | 'done' | 'failed', frames: [...] }
Napi::Value LatencyResult(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto result = engine(env).latencyResult();
  static const char* names[] = {"idle", "running", "done", "failed"};
  Napi::Object object = Napi::Object::New(env);
  object.Set("state", names[static_cast<int>(result.state)]);
  Napi::Array frames = Napi::Array::New(env, result.frames.size());
  for (size_t i = 0; i < result.frames.size(); i++) frames.Set(i, result.frames[i]);
  object.Set("frames", frames);
  return object;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  env.SetInstanceData(new Engine());  // deleted (and audio stopped) when the process unloads the addon
  exports.Set("listDevices", Napi::Function::New(env, ListDevices));
  exports.Set("start", Napi::Function::New(env, Start));
  exports.Set("stop", Napi::Function::New(env, Stop));
  exports.Set("info", Napi::Function::New(env, Info));
  exports.Set("stats", Napi::Function::New(env, Stats));
  exports.Set("setTrack", Napi::Function::New(env, SetTrack));
  exports.Set("clearTrack", Napi::Function::New(env, ClearTrack));
  exports.Set("takePeaks", Napi::Function::New(env, TakePeaks));
  exports.Set("takeInputPeaks", Napi::Function::New(env, TakeInputPeaks));
  exports.Set("startLatencyTest", Napi::Function::New(env, StartLatencyTest));
  exports.Set("latencyResult", Napi::Function::New(env, LatencyResult));
  return exports;
}

}  // namespace

NODE_API_MODULE(resonant_audio, Init)
