// Plugin side: exposes Chordino through the Vamp C interface, so host.cpp can wrap it
// as if it had loaded it from a plugin library. (The SDK keeps plugin and host classes
// in separate namespaces, so the two halves are compiled in separate files.)
#include <vamp-sdk/PluginAdapter.h>

#include "nnls-chroma/Chordino.h"

static Vamp::PluginAdapter<Chordino> chordinoAdapter;

const VampPluginDescriptor *chordinoDescriptor() {
    return chordinoAdapter.getDescriptor();
}
