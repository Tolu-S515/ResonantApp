// Low-latency instrument engine (macOS, CoreAudio).
//
// Reads the interface inputs and writes the monitor mix to its outputs 1/2.
// Backing tracks are played separately by Web Audio on the same interface;
// macOS mixes the two.
//
// Two ways to open the interface:
// - One device with inputs and outputs (most interfaces): a single AUHAL unit,
//   so input and output are serviced by the same device callback. No buffer in
//   between, no drift.
// - Separate input and output devices (budget USB interfaces that macOS splits
//   in two, such as Burr-Brown "USB AUDIO CODEC" ones): one unit per half and a
//   small ring buffer between their callbacks. Both halves run off the same
//   chip's clock, so the buffer holds steady; it costs about one buffer of latency.
//
// Threading: JS calls the public methods; CoreAudio calls the callbacks on its
// real-time threads. Everything they read from JS is an atomic, and they never
// allocate or lock.
#pragma once

#include <AudioToolbox/AudioToolbox.h>
#include <CoreAudio/CoreAudio.h>

#include <atomic>
#include <cstdint>
#include <string>
#include <vector>

namespace resonant {

struct DeviceInfo {
  std::string uid;
  std::string name;
  int inputChannels = 0;
  int outputChannels = 0;
  double sampleRate = 0;
  // Devices with the same non-zero clock domain share one hardware clock (0 = not reported)
  uint32_t clockDomain = 0;
  bool isDefaultInput = false;
  bool isDefaultOutput = false;
};

std::vector<DeviceInfo> listDevices();

// Instrument tracks: each takes one input channel (mono) or two (stereo pair)
constexpr int kMaxTracks = 8;
// Inputs that get their own meter (for the audio settings page)
constexpr int kMaxInputMeters = 16;

struct Track {
  std::atomic<bool> active{false};
  std::atomic<int> left{-1};   // input channel (0-based) for mono, or the left of a pair
  std::atomic<int> right{-1};  // right of a stereo pair, -1 for mono
  std::atomic<float> gain{1};
  std::atomic<float> pan{0};   // -1 (left) .. 1 (right)
  std::atomic<bool> monitor{true};
  // Input peaks (before gain) since the last takePeaks()
  std::atomic<float> peakLeft{0};
  std::atomic<float> peakRight{0};
};

struct TrackSettings {
  int left = -1;
  int right = -1;
  float gain = 1;
  float pan = 0;
  bool monitor = true;
};

struct EngineInfo {
  std::string inputUid;
  std::string outputUid;
  std::string inputName;
  std::string outputName;
  bool split = false;  // separate input and output devices
  double sampleRate = 0;
  int bufferFrames = 0;
  int inputChannels = 0;
  int outputChannels = 0;
  // What CoreAudio reports: device + safety offset + stream latency + one buffer
  int inputLatencyFrames = 0;
  int outputLatencyFrames = 0;
  int bridgeFrames = 0;  // split mode: ring buffer cushion between the halves
};

struct EngineStats {
  int underruns = 0;  // split mode: output ran ahead of input (heard as a dropout)
  int overruns = 0;   // split mode: input piled up and was skipped
  uint64_t inputFrames = 0;   // frames the input side delivered since start
  uint64_t outputFrames = 0;  // frames the output side asked for since start
  int largestInputCallback = 0;
  int largestOutputCallback = 0;
};

// Loopback test: output channel → cable → input channel, timed in samples
constexpr int kLatencyPulses = 5;

enum class LatencyState : int { Idle = 0, Running = 1, Done = 2, Failed = 3 };

struct LatencyResult {
  LatencyState state = LatencyState::Idle;
  std::vector<int> frames;  // round trip of each pulse that came back
};

class Engine {
 public:
  ~Engine();

  // inputUid == outputUid opens one device. Throws std::runtime_error with a readable message.
  void start(const std::string& inputUid, const std::string& outputUid, int bufferFrames);
  void stop();
  bool running() const { return outputUnit_ != nullptr; }
  EngineInfo info() const { return info_; }
  EngineStats stats() const;

  void setTrack(int index, const TrackSettings& settings);
  void clearTrack(int index);
  // Input peaks since the last call, then resets them
  void takePeaks(int index, float& left, float& right);
  // Peak of each input channel since the last call (up to kMaxInputMeters), then resets them
  std::vector<float> takeInputPeaks();

  // Monitoring is muted while the test runs, so a loopback cable can't feed back.
  // In split mode the result includes the ring buffer, like monitoring does.
  void startLatencyTest(int outputChannel, int inputChannel);
  LatencyResult latencyResult() const;

 private:
  static OSStatus outputCallback(void* ref, AudioUnitRenderActionFlags* flags, const AudioTimeStamp* timestamp,
                                 UInt32 bus, UInt32 frames, AudioBufferList* output);
  static OSStatus inputCallback(void* ref, AudioUnitRenderActionFlags* flags, const AudioTimeStamp* timestamp,
                                UInt32 bus, UInt32 frames, AudioBufferList* unused);
  OSStatus renderOutput(AudioUnitRenderActionFlags* flags, const AudioTimeStamp* timestamp, UInt32 frames,
                        AudioBufferList* output);
  bool captureInput(AudioUnit unit, AudioUnitRenderActionFlags* flags, const AudioTimeStamp* timestamp, UInt32 frames);
  void pushToBridge(UInt32 frames);
  void pullFromBridge(UInt32 frames);
  void mix(const std::vector<std::vector<float>>& inputs, UInt32 frames, AudioBufferList* output);
  void runLatencyTest(const std::vector<std::vector<float>>& inputs, UInt32 frames, AudioBufferList* output);

  AudioUnit outputUnit_ = nullptr;  // also does input when there's one device
  AudioUnit inputUnit_ = nullptr;   // split mode only
  EngineInfo info_;
  Track tracks_[kMaxTracks];
  std::atomic<float> inputPeaks_[kMaxInputMeters];

  // Where the device's input lands, one buffer per channel. Written on the
  // input callback's thread (the output callback's, with one device).
  std::vector<std::vector<float>> capture_;
  std::vector<uint8_t> captureListStorage_;
  AudioBufferList* captureList_ = nullptr;
  UInt32 maxFrames_ = 0;

  // Split mode: input frames handed from the input thread to the output thread.
  // Single producer, single consumer; frame counts only grow.
  std::vector<float> bridge_;  // interleaved, bridgeCapacity_ frames
  uint64_t bridgeCapacity_ = 0;  // power of two
  std::atomic<uint64_t> bridgeWritten_{0};
  std::atomic<uint64_t> bridgeRead_{0};
  bool bridgePrimed_ = false;  // output thread only
  std::vector<std::vector<float>> bridged_;  // output thread's copy of the input
  std::atomic<int> underruns_{0};
  std::atomic<int> overruns_{0};

  uint64_t frameCounter_ = 0;  // output thread only
  std::atomic<uint64_t> inputFrames_{0};
  std::atomic<uint64_t> outputFrames_{0};
  std::atomic<int> largestInput_{0};
  std::atomic<int> largestOutput_{0};

  // Latency test. JS sets the request; the output thread owns the run.
  std::atomic<bool> latencyRequested_{false};
  std::atomic<int> latencyOutput_{0};
  std::atomic<int> latencyInput_{0};
  std::atomic<int> latencyState_{0};
  std::atomic<int> latencyCount_{0};
  std::atomic<int> latencyFrames_[kLatencyPulses];
  // Output thread only
  int testOutput_ = 0;
  int testInput_ = 0;
  uint64_t pulseAt_ = 0;  // frame the current pulse starts
  bool waiting_ = false;  // pulse sent, not heard back yet
};

}  // namespace resonant
