// chordino: chord changes in a mono recording, using Chordino (NNLS Chroma) built in.
//
//   chordino <sample rate>  < audio.f32  > chords.tsv
//
// Reads mono 32-bit float samples (native byte order) from stdin until EOF, and
// writes one line per chord change: "<seconds>\t<chord>", where "N" means no chord.
// Diagnostics go to stderr. Called by processing/process.py.
#include <vamp-hostsdk/PluginHostAdapter.h>
#include <vamp-hostsdk/PluginInputDomainAdapter.h>

#include <cstdio>
#include <cstdlib>
#include <algorithm>
#include <cstring>
#include <memory>
#include <string>
#include <vector>

using Vamp::Plugin;
using Vamp::PluginHostAdapter;
using Vamp::RealTime;
using Vamp::HostExt::PluginInputDomainAdapter;

const VampPluginDescriptor *chordinoDescriptor(); // plugin.cpp

static int fail(const std::string &message) {
    std::fprintf(stderr, "chordino: %s\n", message.c_str());
    return 1;
}

static void printFeatures(const Plugin::FeatureList &features) {
    for (const auto &f : features) {
        double seconds = f.timestamp.sec + f.timestamp.nsec / 1e9;
        std::printf("%.4f\t%s\n", seconds, f.label.c_str());
    }
}

int main(int argc, char **argv) {
    if (argc != 2) return fail("usage: chordino <sample rate>  < mono float32 samples");
    const float sampleRate = std::strtof(argv[1], nullptr);
    if (!(sampleRate >= 8000 && sampleRate <= 192000)) return fail("invalid sample rate");

    // Chordino reads an optional chord.dict from the Vamp plugin path; point it
    // nowhere so results never depend on what's installed on this computer
    setenv("VAMP_PATH", "/nonexistent", 1);

    std::vector<float> audio;
    float chunk[65536];
    size_t got;
    while ((got = std::fread(chunk, sizeof(float), 65536, stdin)) > 0) audio.insert(audio.end(), chunk, chunk + got);
    if (audio.empty()) return fail("no audio on stdin");

    // Chordino works on spectra; the adapter feeds it FFT frames of the audio
    auto plugin = std::make_unique<PluginInputDomainAdapter>(new PluginHostAdapter(chordinoDescriptor(), sampleRate));
    const size_t step = plugin->getPreferredStepSize();
    const size_t block = plugin->getPreferredBlockSize();
    if (!plugin->initialise(1, step, block)) return fail("could not start Chordino");

    int output = -1;
    const auto outputs = plugin->getOutputDescriptors();
    for (size_t i = 0; i < outputs.size(); i++) {
        if (outputs[i].identifier == "simplechord") output = int(i);
    }
    if (output < 0) return fail("Chordino has no simplechord output");

    std::vector<float> buffer(block);
    for (size_t start = 0; start < audio.size(); start += step) {
        const size_t n = std::min(block, audio.size() - start);
        std::memcpy(buffer.data(), audio.data() + start, n * sizeof(float));
        std::fill(buffer.begin() + n, buffer.end(), 0.0f); // zero-pad the last blocks
        const float *channels[] = {buffer.data()};
        auto features = plugin->process(channels, RealTime::frame2RealTime(long(start), int(sampleRate)));
        printFeatures(features[output]);
    }
    printFeatures(plugin->getRemainingFeatures()[output]);
    return 0;
}
