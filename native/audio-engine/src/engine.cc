#include "engine.h"

#include <algorithm>
#include <cmath>
#include <stdexcept>

namespace resonant {

namespace {

// Loopback test pulse: short, loud enough to find, far below clipping
constexpr float kPulseLevel = 0.5f;
constexpr int kPulseFrames = 8;
constexpr float kDetectLevel = 0.1f;  // -20 dBFS
constexpr double kPulseGapSeconds = 0.4;
constexpr double kPulseTimeoutSeconds = 1.0;

// Split mode: input kept in hand beyond one callback's worth, to absorb the two
// callbacks firing at slightly different moments. More than this backlog
// (after a stall) is skipped so latency can't creep up.
constexpr int kBridgeCushionBuffers = 1;
constexpr int kBridgeMaxBacklogBuffers = 4;
// The halves start a moment apart and settle within this; skips before then
// are part of starting up, not glitches, so they aren't counted
constexpr double kBridgeWarmupSeconds = 1.0;

std::string toString(CFStringRef value) {
  if (!value) return {};
  char buffer[512];
  if (CFStringGetCString(value, buffer, sizeof buffer, kCFStringEncodingUTF8)) return buffer;
  return {};
}

std::string statusMessage(const char* what, OSStatus status) {
  return std::string(what) + " failed (CoreAudio error " + std::to_string(static_cast<int>(status)) + ")";
}

void check(OSStatus status, const char* what) {
  if (status != noErr) throw std::runtime_error(statusMessage(what, status));
}

template <typename T>
bool getProperty(AudioObjectID object, AudioObjectPropertySelector selector, AudioObjectPropertyScope scope, T& out) {
  AudioObjectPropertyAddress address{selector, scope, kAudioObjectPropertyElementMain};
  UInt32 size = sizeof(T);
  return AudioObjectGetPropertyData(object, &address, 0, nullptr, &size, &out) == noErr;
}

std::string stringProperty(AudioObjectID object, AudioObjectPropertySelector selector) {
  CFStringRef value = nullptr;
  if (!getProperty(object, selector, kAudioObjectPropertyScopeGlobal, value)) return {};
  std::string result = toString(value);
  CFRelease(value);
  return result;
}

int channelCount(AudioDeviceID device, AudioObjectPropertyScope scope) {
  AudioObjectPropertyAddress address{kAudioDevicePropertyStreamConfiguration, scope, kAudioObjectPropertyElementMain};
  UInt32 size = 0;
  if (AudioObjectGetPropertyDataSize(device, &address, 0, nullptr, &size) != noErr || size == 0) return 0;
  std::vector<uint8_t> storage(size);
  auto* list = reinterpret_cast<AudioBufferList*>(storage.data());
  if (AudioObjectGetPropertyData(device, &address, 0, nullptr, &size, list) != noErr) return 0;
  int channels = 0;
  for (UInt32 i = 0; i < list->mNumberBuffers; i++) channels += static_cast<int>(list->mBuffers[i].mNumberChannels);
  return channels;
}

std::vector<AudioDeviceID> deviceIds() {
  AudioObjectPropertyAddress address{kAudioHardwarePropertyDevices, kAudioObjectPropertyScopeGlobal,
                                     kAudioObjectPropertyElementMain};
  UInt32 size = 0;
  if (AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &address, 0, nullptr, &size) != noErr) return {};
  std::vector<AudioDeviceID> ids(size / sizeof(AudioDeviceID));
  if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &address, 0, nullptr, &size, ids.data()) != noErr) return {};
  return ids;
}

AudioDeviceID findDevice(const std::string& uid) {
  for (AudioDeviceID id : deviceIds()) {
    if (stringProperty(id, kAudioDevicePropertyDeviceUID) == uid) return id;
  }
  throw std::runtime_error("Audio device not found: " + uid);
}

// Device latency + safety offset + the first stream's latency, in frames
int reportedLatency(AudioDeviceID device, AudioObjectPropertyScope scope) {
  UInt32 deviceLatency = 0, safetyOffset = 0, streamLatency = 0;
  getProperty(device, kAudioDevicePropertyLatency, scope, deviceLatency);
  getProperty(device, kAudioDevicePropertySafetyOffset, scope, safetyOffset);

  AudioObjectPropertyAddress address{kAudioDevicePropertyStreams, scope, kAudioObjectPropertyElementMain};
  UInt32 size = 0;
  if (AudioObjectGetPropertyDataSize(device, &address, 0, nullptr, &size) == noErr && size >= sizeof(AudioStreamID)) {
    std::vector<AudioStreamID> streams(size / sizeof(AudioStreamID));
    if (AudioObjectGetPropertyData(device, &address, 0, nullptr, &size, streams.data()) == noErr) {
      getProperty(streams[0], kAudioStreamPropertyLatency, kAudioObjectPropertyScopeGlobal, streamLatency);
    }
  }
  return static_cast<int>(deviceLatency + safetyOffset + streamLatency);
}

// Sets the device's buffer size, clamped to what it allows. The setting is per
// device and shared with other apps using it. Returns the size in effect.
UInt32 setBufferSize(AudioDeviceID device, int requested) {
  AudioValueRange range{};
  if (getProperty(device, kAudioDevicePropertyBufferFrameSizeRange, kAudioObjectPropertyScopeGlobal, range)) {
    requested = std::clamp(requested, static_cast<int>(range.mMinimum), static_cast<int>(range.mMaximum));
  }
  UInt32 frames = static_cast<UInt32>(requested);
  AudioObjectPropertyAddress address{kAudioDevicePropertyBufferFrameSize, kAudioObjectPropertyScopeGlobal,
                                     kAudioObjectPropertyElementMain};
  check(AudioObjectSetPropertyData(device, &address, 0, nullptr, sizeof frames, &frames), "Setting buffer size");
  getProperty(device, kAudioDevicePropertyBufferFrameSize, kAudioObjectPropertyScopeGlobal, frames);
  return frames;
}

AudioStreamBasicDescription floatFormat(double sampleRate, int channels) {
  AudioStreamBasicDescription format{};
  format.mSampleRate = sampleRate;
  format.mFormatID = kAudioFormatLinearPCM;
  format.mFormatFlags = kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked | kAudioFormatFlagIsNonInterleaved;
  format.mBitsPerChannel = 32;
  format.mChannelsPerFrame = static_cast<UInt32>(channels);
  format.mFramesPerPacket = 1;
  format.mBytesPerFrame = sizeof(float);  // per channel, as the format is non-interleaved
  format.mBytesPerPacket = sizeof(float);
  return format;
}

// Owns an AUHAL unit until released, so a failed start never leaks one
struct UnitHolder {
  AudioUnit unit = nullptr;
  bool initialized = false;
  ~UnitHolder() {
    if (!unit) return;
    if (initialized) AudioUnitUninitialize(unit);
    AudioComponentInstanceDispose(unit);
  }
  AudioUnit release() {
    AudioUnit result = unit;
    unit = nullptr;
    return result;
  }
};

// An AUHAL unit on `device` with input (element 1) and/or output (element 0)
// enabled, using our float format on whichever sides are enabled
void createUnit(UnitHolder& holder, AudioDeviceID device, double sampleRate, int inputChannels, int outputChannels) {
  AudioComponentDescription description{kAudioUnitType_Output, kAudioUnitSubType_HALOutput,
                                        kAudioUnitManufacturer_Apple, 0, 0};
  AudioComponent component = AudioComponentFindNext(nullptr, &description);
  if (!component) throw std::runtime_error("CoreAudio HAL output unit not available");
  check(AudioComponentInstanceNew(component, &holder.unit), "Creating audio unit");
  AudioUnit unit = holder.unit;

  UInt32 enableInput = inputChannels > 0, enableOutput = outputChannels > 0;
  check(AudioUnitSetProperty(unit, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Input, 1, &enableInput,
                             sizeof enableInput),
        "Enabling input");
  check(AudioUnitSetProperty(unit, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Output, 0, &enableOutput,
                             sizeof enableOutput),
        "Enabling output");
  check(AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &device,
                             sizeof device),
        "Selecting device");

  if (inputChannels > 0) {
    AudioStreamBasicDescription format = floatFormat(sampleRate, inputChannels);
    check(AudioUnitSetProperty(unit, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Output, 1, &format, sizeof format),
          "Setting input format");
  }
  if (outputChannels > 0) {
    AudioStreamBasicDescription format = floatFormat(sampleRate, outputChannels);
    check(AudioUnitSetProperty(unit, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Input, 0, &format, sizeof format),
          "Setting output format");
  }
}

UInt32 maxFramesPerSlice(AudioUnit unit) {
  UInt32 frames = 4096;
  UInt32 size = sizeof frames;
  AudioUnitGetProperty(unit, kAudioUnitProperty_MaximumFramesPerSlice, kAudioUnitScope_Global, 0, &frames, &size);
  return frames;
}

uint64_t nextPowerOfTwo(uint64_t value) {
  uint64_t result = 1;
  while (result < value) result <<= 1;
  return result;
}

// Audio-thread peak update; a lost race with takePeaks only drops one reading
void raisePeak(std::atomic<float>& peak, float value) {
  if (value > peak.load(std::memory_order_relaxed)) peak.store(value, std::memory_order_relaxed);
}

float peakOf(const float* samples, UInt32 frames) {
  float peak = 0;
  for (UInt32 i = 0; i < frames; i++) peak = std::max(peak, std::fabs(samples[i]));
  return peak;
}

}  // namespace

std::vector<DeviceInfo> listDevices() {
  AudioDeviceID defaultInput = kAudioObjectUnknown, defaultOutput = kAudioObjectUnknown;
  getProperty(kAudioObjectSystemObject, kAudioHardwarePropertyDefaultInputDevice, kAudioObjectPropertyScopeGlobal,
              defaultInput);
  getProperty(kAudioObjectSystemObject, kAudioHardwarePropertyDefaultOutputDevice, kAudioObjectPropertyScopeGlobal,
              defaultOutput);

  std::vector<DeviceInfo> devices;
  for (AudioDeviceID id : deviceIds()) {
    DeviceInfo device;
    device.uid = stringProperty(id, kAudioDevicePropertyDeviceUID);
    device.name = stringProperty(id, kAudioObjectPropertyName);
    device.inputChannels = channelCount(id, kAudioObjectPropertyScopeInput);
    device.outputChannels = channelCount(id, kAudioObjectPropertyScopeOutput);
    Float64 rate = 0;
    getProperty(id, kAudioDevicePropertyNominalSampleRate, kAudioObjectPropertyScopeGlobal, rate);
    device.sampleRate = rate;
    UInt32 domain = 0;
    getProperty(id, kAudioDevicePropertyClockDomain, kAudioObjectPropertyScopeGlobal, domain);
    device.clockDomain = domain;
    device.isDefaultInput = id == defaultInput;
    device.isDefaultOutput = id == defaultOutput;
    devices.push_back(device);
  }
  return devices;
}

Engine::~Engine() { stop(); }

void Engine::start(const std::string& inputUid, const std::string& outputUid, int bufferFrames) {
  stop();

  const bool split = inputUid != outputUid;
  AudioDeviceID inputDevice = findDevice(inputUid);
  AudioDeviceID outputDevice = split ? findDevice(outputUid) : inputDevice;
  const int inputChannels = channelCount(inputDevice, kAudioObjectPropertyScopeInput);
  const int outputChannels = channelCount(outputDevice, kAudioObjectPropertyScopeOutput);
  if (inputChannels == 0) throw std::runtime_error("The input device has no inputs");
  if (outputChannels == 0) throw std::runtime_error("The output device has no outputs");

  Float64 sampleRate = 0, outputRate = 0;
  getProperty(inputDevice, kAudioDevicePropertyNominalSampleRate, kAudioObjectPropertyScopeGlobal, sampleRate);
  getProperty(outputDevice, kAudioDevicePropertyNominalSampleRate, kAudioObjectPropertyScopeGlobal, outputRate);
  if (sampleRate != outputRate) {
    throw std::runtime_error("Input runs at " + std::to_string(static_cast<int>(sampleRate)) + " Hz and output at " +
                             std::to_string(static_cast<int>(outputRate)) +
                             " Hz; set both to the same rate in Audio MIDI Setup");
  }

  UInt32 frames = setBufferSize(inputDevice, bufferFrames);
  if (split) setBufferSize(outputDevice, static_cast<int>(frames));

  UnitHolder output, input;
  if (split) {
    createUnit(output, outputDevice, sampleRate, 0, outputChannels);
    createUnit(input, inputDevice, sampleRate, inputChannels, 0);
    AURenderCallbackStruct inputCallbackInfo{&Engine::inputCallback, this};
    check(AudioUnitSetProperty(input.unit, kAudioOutputUnitProperty_SetInputCallback, kAudioUnitScope_Global, 0,
                               &inputCallbackInfo, sizeof inputCallbackInfo),
          "Setting input callback");
  } else {
    createUnit(output, outputDevice, sampleRate, inputChannels, outputChannels);
  }
  AURenderCallbackStruct outputCallbackInfo{&Engine::outputCallback, this};
  check(AudioUnitSetProperty(output.unit, kAudioUnitProperty_SetRenderCallback, kAudioUnitScope_Input, 0,
                             &outputCallbackInfo, sizeof outputCallbackInfo),
        "Setting render callback");

  check(AudioUnitInitialize(output.unit), "Initializing output");
  output.initialized = true;
  if (split) {
    check(AudioUnitInitialize(input.unit), "Initializing input");
    input.initialized = true;
  }

  // Buffers are allocated here, never on an audio thread
  maxFrames_ = std::max(maxFramesPerSlice(output.unit), split ? maxFramesPerSlice(input.unit) : 0u);
  capture_.assign(inputChannels, std::vector<float>(maxFrames_));
  captureListStorage_.assign(offsetof(AudioBufferList, mBuffers) + sizeof(AudioBuffer) * inputChannels, 0);
  captureList_ = reinterpret_cast<AudioBufferList*>(captureListStorage_.data());
  captureList_->mNumberBuffers = static_cast<UInt32>(inputChannels);
  for (int c = 0; c < inputChannels; c++) {
    captureList_->mBuffers[c].mNumberChannels = 1;
    captureList_->mBuffers[c].mData = capture_[c].data();
    captureList_->mBuffers[c].mDataByteSize = maxFrames_ * sizeof(float);
  }
  const int cushion = split ? kBridgeCushionBuffers * static_cast<int>(frames) : 0;
  if (split) {
    bridgeCapacity_ = nextPowerOfTwo(static_cast<uint64_t>(maxFrames_) * 2 + frames * (kBridgeMaxBacklogBuffers + 2));
    bridge_.assign(bridgeCapacity_ * inputChannels, 0.0f);
    bridged_.assign(inputChannels, std::vector<float>(maxFrames_));
  } else {
    bridge_.clear();
    bridged_.clear();
    bridgeCapacity_ = 0;
  }
  bridgeWritten_.store(0);
  bridgeRead_.store(0);
  bridgePrimed_ = false;
  underruns_.store(0);
  overruns_.store(0);
  inputFrames_.store(0);
  outputFrames_.store(0);
  largestInput_.store(0);
  largestOutput_.store(0);
  frameCounter_ = 0;
  latencyState_.store(static_cast<int>(LatencyState::Idle));

  info_ = EngineInfo{};
  info_.inputUid = inputUid;
  info_.outputUid = outputUid;
  info_.inputName = stringProperty(inputDevice, kAudioObjectPropertyName);
  info_.outputName = stringProperty(outputDevice, kAudioObjectPropertyName);
  info_.split = split;
  info_.sampleRate = sampleRate;
  info_.bufferFrames = static_cast<int>(frames);
  info_.inputChannels = inputChannels;
  info_.outputChannels = outputChannels;
  info_.inputLatencyFrames = reportedLatency(inputDevice, kAudioObjectPropertyScopeInput) + static_cast<int>(frames);
  info_.outputLatencyFrames = reportedLatency(outputDevice, kAudioObjectPropertyScopeOutput) + static_cast<int>(frames);
  info_.bridgeFrames = cushion;

  // The callbacks use these members, so publish the units before starting them
  outputUnit_ = output.unit;
  inputUnit_ = split ? input.unit : nullptr;
  if (split) {
    OSStatus status = AudioOutputUnitStart(input.unit);
    if (status != noErr) {
      outputUnit_ = inputUnit_ = nullptr;
      throw std::runtime_error(statusMessage("Starting input", status));
    }
  }
  OSStatus status = AudioOutputUnitStart(output.unit);
  if (status != noErr) {
    if (split) AudioOutputUnitStop(input.unit);
    outputUnit_ = inputUnit_ = nullptr;
    throw std::runtime_error(statusMessage("Starting output", status));
  }
  output.release();
  input.release();
}

void Engine::stop() {
  // AudioOutputUnitStop returns once that unit's callback has finished
  for (AudioUnit* unit : {&outputUnit_, &inputUnit_}) {
    if (!*unit) continue;
    AudioOutputUnitStop(*unit);
  }
  for (AudioUnit* unit : {&outputUnit_, &inputUnit_}) {
    if (!*unit) continue;
    AudioUnitUninitialize(*unit);
    AudioComponentInstanceDispose(*unit);
    *unit = nullptr;
  }
  latencyState_.store(static_cast<int>(LatencyState::Idle));
}

EngineStats Engine::stats() const {
  return {underruns_.load(), overruns_.load(), inputFrames_.load(), outputFrames_.load(), largestInput_.load(),
          largestOutput_.load()};
}

void Engine::setTrack(int index, const TrackSettings& settings) {
  if (index < 0 || index >= kMaxTracks) throw std::runtime_error("Track index out of range");
  Track& track = tracks_[index];
  track.left.store(settings.left);
  track.right.store(settings.right);
  track.gain.store(settings.gain);
  track.pan.store(std::clamp(settings.pan, -1.0f, 1.0f));
  track.monitor.store(settings.monitor);
  track.active.store(true);
}

void Engine::clearTrack(int index) {
  if (index < 0 || index >= kMaxTracks) throw std::runtime_error("Track index out of range");
  tracks_[index].active.store(false);
}

void Engine::takePeaks(int index, float& left, float& right) {
  if (index < 0 || index >= kMaxTracks) throw std::runtime_error("Track index out of range");
  left = tracks_[index].peakLeft.exchange(0);
  right = tracks_[index].peakRight.exchange(0);
}

std::vector<float> Engine::takeInputPeaks() {
  const int count = std::min(info_.inputChannels, kMaxInputMeters);
  std::vector<float> peaks(count);
  for (int c = 0; c < count; c++) peaks[c] = inputPeaks_[c].exchange(0);
  return peaks;
}

void Engine::startLatencyTest(int outputChannel, int inputChannel) {
  if (!running()) throw std::runtime_error("Audio is not running");
  if (outputChannel < 0 || outputChannel >= info_.outputChannels) throw std::runtime_error("No such output channel");
  if (inputChannel < 0 || inputChannel >= info_.inputChannels) throw std::runtime_error("No such input channel");
  latencyOutput_.store(outputChannel);
  latencyInput_.store(inputChannel);
  latencyCount_.store(0);
  latencyState_.store(static_cast<int>(LatencyState::Running));
  latencyRequested_.store(true);
}

LatencyResult Engine::latencyResult() const {
  LatencyResult result;
  result.state = static_cast<LatencyState>(latencyState_.load());
  int count = latencyCount_.load();
  for (int i = 0; i < count; i++) result.frames.push_back(latencyFrames_[i].load());
  return result;
}

OSStatus Engine::outputCallback(void* ref, AudioUnitRenderActionFlags* flags, const AudioTimeStamp* timestamp, UInt32,
                                UInt32 frames, AudioBufferList* output) {
  return static_cast<Engine*>(ref)->renderOutput(flags, timestamp, frames, output);
}

// Split mode only: the input half has new frames
OSStatus Engine::inputCallback(void* ref, AudioUnitRenderActionFlags* flags, const AudioTimeStamp* timestamp, UInt32,
                               UInt32 frames, AudioBufferList*) {
  auto* engine = static_cast<Engine*>(ref);
  if (engine->captureInput(engine->inputUnit_, flags, timestamp, frames)) engine->pushToBridge(frames);
  return noErr;
}

// Pulls `frames` of input from the unit's element 1 into capture_
bool Engine::captureInput(AudioUnit unit, AudioUnitRenderActionFlags* flags, const AudioTimeStamp* timestamp,
                          UInt32 frames) {
  inputFrames_.fetch_add(frames, std::memory_order_relaxed);
  if (static_cast<int>(frames) > largestInput_.load(std::memory_order_relaxed)) largestInput_.store(static_cast<int>(frames));
  if (frames > maxFrames_) return false;  // can't happen per MaximumFramesPerSlice
  for (UInt32 c = 0; c < captureList_->mNumberBuffers; c++) captureList_->mBuffers[c].mDataByteSize = frames * sizeof(float);
  return AudioUnitRender(unit, flags, timestamp, 1, frames, captureList_) == noErr;
}

void Engine::pushToBridge(UInt32 frames) {
  const uint64_t written = bridgeWritten_.load(std::memory_order_relaxed);
  const uint64_t read = bridgeRead_.load(std::memory_order_acquire);
  if (written - read + frames > bridgeCapacity_) {
    // Output isn't reading (it starts a moment after input, or it stalled): drop
    if (outputFrames_.load(std::memory_order_relaxed) > info_.sampleRate * kBridgeWarmupSeconds) {
      overruns_.fetch_add(1, std::memory_order_relaxed);
    }
    return;
  }
  const size_t channels = capture_.size();
  const uint64_t mask = bridgeCapacity_ - 1;
  for (UInt32 f = 0; f < frames; f++) {
    float* frame = &bridge_[((written + f) & mask) * channels];
    for (size_t c = 0; c < channels; c++) frame[c] = capture_[c][f];
  }
  bridgeWritten_.store(written + frames, std::memory_order_release);
}

// Fills bridged_ with the next `frames` of input, or silence while the bridge
// (re)fills. Keeps the backlog near one cushion so latency stays put.
void Engine::pullFromBridge(UInt32 frames) {
  const uint64_t cushion = static_cast<uint64_t>(info_.bridgeFrames);
  const uint64_t written = bridgeWritten_.load(std::memory_order_acquire);
  uint64_t read = bridgeRead_.load(std::memory_order_relaxed);
  uint64_t available = written - read;

  auto silence = [&] {
    for (auto& channel : bridged_) std::fill_n(channel.begin(), frames, 0.0f);
  };
  if (!bridgePrimed_) {
    if (available < frames + cushion) return silence();
    bridgePrimed_ = true;
  }
  if (available < frames) {
    underruns_.fetch_add(1, std::memory_order_relaxed);
    bridgePrimed_ = false;
    return silence();
  }
  const uint64_t maxBacklog = frames + cushion + static_cast<uint64_t>(info_.bufferFrames) * kBridgeMaxBacklogBuffers;
  if (available > maxBacklog) {
    if (frameCounter_ > info_.sampleRate * kBridgeWarmupSeconds) overruns_.fetch_add(1, std::memory_order_relaxed);
    read = written - (frames + cushion);
  }

  const size_t channels = bridged_.size();
  const uint64_t mask = bridgeCapacity_ - 1;
  for (UInt32 f = 0; f < frames; f++) {
    const float* frame = &bridge_[((read + f) & mask) * channels];
    for (size_t c = 0; c < channels; c++) bridged_[c][f] = frame[c];
  }
  bridgeRead_.store(read + frames, std::memory_order_release);
}

OSStatus Engine::renderOutput(AudioUnitRenderActionFlags* flags, const AudioTimeStamp* timestamp, UInt32 frames,
                              AudioBufferList* output) {
  outputFrames_.fetch_add(frames, std::memory_order_relaxed);
  if (static_cast<int>(frames) > largestOutput_.load(std::memory_order_relaxed)) largestOutput_.store(static_cast<int>(frames));
  for (UInt32 b = 0; b < output->mNumberBuffers; b++) {
    std::fill_n(static_cast<float*>(output->mBuffers[b].mData), frames, 0.0f);
  }
  if (frames > maxFrames_) return noErr;  // can't happen per MaximumFramesPerSlice; stay silent if it does

  // One device: its input arrives in this same callback. Split: from the bridge.
  const std::vector<std::vector<float>>* inputs = &capture_;
  if (inputUnit_) {
    pullFromBridge(frames);
    inputs = &bridged_;
  } else if (!captureInput(outputUnit_, flags, timestamp, frames)) {
    frameCounter_ += frames;
    return noErr;
  }

  if (latencyRequested_.exchange(false)) {
    testOutput_ = latencyOutput_.load();
    testInput_ = latencyInput_.load();
    pulseAt_ = frameCounter_;
    waiting_ = false;
  }
  if (latencyState_.load(std::memory_order_relaxed) == static_cast<int>(LatencyState::Running)) {
    runLatencyTest(*inputs, frames, output);  // no monitoring while testing
  } else {
    const int meters = std::min(static_cast<int>(inputs->size()), kMaxInputMeters);
    for (int c = 0; c < meters; c++) raisePeak(inputPeaks_[c], peakOf((*inputs)[c].data(), frames));
    mix(*inputs, frames, output);
  }
  frameCounter_ += frames;
  return noErr;
}

void Engine::mix(const std::vector<std::vector<float>>& inputs, UInt32 frames, AudioBufferList* output) {
  const int inputCount = static_cast<int>(inputs.size());
  float* outLeft = static_cast<float*>(output->mBuffers[0].mData);
  float* outRight = output->mNumberBuffers > 1 ? static_cast<float*>(output->mBuffers[1].mData) : nullptr;

  for (Track& track : tracks_) {
    if (!track.active.load(std::memory_order_relaxed)) continue;
    int left = track.left.load(std::memory_order_relaxed);
    int right = track.right.load(std::memory_order_relaxed);
    if (left < 0 || left >= inputCount || right >= inputCount) continue;
    const float* inLeft = inputs[left].data();
    const float* inRight = right >= 0 ? inputs[right].data() : nullptr;

    // Meters show the input itself, so they warn about clipping at the interface
    float peakLeft = peakOf(inLeft, frames);
    raisePeak(track.peakLeft, peakLeft);
    raisePeak(track.peakRight, inRight ? peakOf(inRight, frames) : peakLeft);

    if (!track.monitor.load(std::memory_order_relaxed)) continue;
    float gain = track.gain.load(std::memory_order_relaxed);
    float pan = track.pan.load(std::memory_order_relaxed);
    float gainLeft, gainRight;
    if (inRight) {
      // Stereo: balance, so the centre leaves both sides untouched
      gainLeft = gain * (pan > 0 ? 1 - pan : 1);
      gainRight = gain * (pan < 0 ? 1 + pan : 1);
    } else {
      // Mono: equal-power pan (-3 dB each side in the centre)
      float angle = (pan + 1) * static_cast<float>(M_PI) / 4;
      gainLeft = gain * std::cos(angle);
      gainRight = gain * std::sin(angle);
    }

    if (outRight) {
      for (UInt32 i = 0; i < frames; i++) {
        outLeft[i] += inLeft[i] * gainLeft;
        outRight[i] += (inRight ? inRight[i] : inLeft[i]) * gainRight;
      }
    } else {
      // Mono output: fold both sides together
      for (UInt32 i = 0; i < frames; i++) {
        outLeft[i] += 0.5f * (inLeft[i] * gainLeft + (inRight ? inRight[i] : inLeft[i]) * gainRight);
      }
    }
  }

  // Hard limit, so a hot input can't wrap around into a loud burst
  for (UInt32 i = 0; i < frames; i++) {
    outLeft[i] = std::clamp(outLeft[i], -1.0f, 1.0f);
    if (outRight) outRight[i] = std::clamp(outRight[i], -1.0f, 1.0f);
  }
}

// Sends a pulse, waits for it on the input, records the delay, repeats.
// Timed on the output callback's frame counter: with one device the input
// arrives in the same callback; split, it arrives through the bridge, so the
// result is the delay monitoring actually has.
void Engine::runLatencyTest(const std::vector<std::vector<float>>& inputs, UInt32 frames, AudioBufferList* output) {
  const uint64_t start = frameCounter_;
  const uint64_t end = start + frames;
  const auto gap = static_cast<uint64_t>(info_.sampleRate * kPulseGapSeconds);
  const auto timeout = static_cast<uint64_t>(info_.sampleRate * kPulseTimeoutSeconds);

  // Write any part of the current pulse that falls in this callback
  if (pulseAt_ < end && pulseAt_ + kPulseFrames > start && testOutput_ < static_cast<int>(output->mNumberBuffers)) {
    float* out = static_cast<float*>(output->mBuffers[testOutput_].mData);
    uint64_t from = std::max(pulseAt_, start), to = std::min(pulseAt_ + kPulseFrames, end);
    for (uint64_t f = from; f < to; f++) out[f - start] = kPulseLevel;
    waiting_ = true;
  }
  if (!waiting_) return;

  const float* in = inputs[testInput_].data();
  for (uint64_t f = std::max(start, pulseAt_); f < end; f++) {
    if (std::fabs(in[f - start]) < kDetectLevel) continue;
    int count = latencyCount_.load(std::memory_order_relaxed);
    latencyFrames_[count].store(static_cast<int>(f - pulseAt_));
    latencyCount_.store(count + 1);
    waiting_ = false;
    if (count + 1 == kLatencyPulses) {
      latencyState_.store(static_cast<int>(LatencyState::Done));
      return;
    }
    pulseAt_ = f + gap;  // let the pulse die away before the next one
    return;
  }
  if (end - pulseAt_ > timeout) latencyState_.store(static_cast<int>(LatencyState::Failed));
}

}  // namespace resonant
