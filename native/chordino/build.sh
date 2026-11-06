#!/bin/sh
# Builds native/chordino/build/chordino (run with: npm run build:chordino)
set -e
cd "$(dirname "$0")"
mkdir -p build

SDK=vamp-plugin-sdk
FLAGS="-O2 -w -DNDEBUG -I$SDK -I."

# nnls.c is C; everything else is C++
cc $FLAGS -c nnls-chroma/nnls.c -o build/nnls.o

c++ -std=c++14 $FLAGS -o build/chordino \
  host.cpp plugin.cpp \
  nnls-chroma/Chordino.cpp nnls-chroma/NNLSBase.cpp nnls-chroma/chromamethods.cpp nnls-chroma/viterbi.cpp \
  build/nnls.o \
  $SDK/src/vamp-sdk/PluginAdapter.cpp $SDK/src/vamp-sdk/RealTime.cpp $SDK/src/vamp-sdk/FFT.cpp \
  $SDK/src/vamp-hostsdk/PluginHostAdapter.cpp $SDK/src/vamp-hostsdk/PluginInputDomainAdapter.cpp \
  $SDK/src/vamp-hostsdk/PluginWrapper.cpp $SDK/src/vamp-hostsdk/RealTime.cpp $SDK/src/vamp-hostsdk/Files.cpp

echo "Built $(pwd)/build/chordino"
