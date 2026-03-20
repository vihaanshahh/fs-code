#!/usr/bin/env node
/**
 * Patches tree-sitter's binding.gyp to use C++20 instead of C++17.
 * Required for Electron 35+ which uses V8 headers that require C++20.
 * Runs automatically as part of postinstall.
 */
const fs = require('fs');
const path = require('path');

const bindingGyp = path.join(__dirname, '..', 'node_modules', 'tree-sitter', 'binding.gyp');

if (fs.existsSync(bindingGyp)) {
  let content = fs.readFileSync(bindingGyp, 'utf-8');
  if (content.includes('c++17')) {
    content = content.replace(/c\+\+17/g, 'c++20');
    fs.writeFileSync(bindingGyp, content);
    console.log('[patch-tree-sitter] Patched binding.gyp: c++17 -> c++20');
  } else {
    console.log('[patch-tree-sitter] Already patched or not needed');
  }
} else {
  console.log('[patch-tree-sitter] tree-sitter not installed, skipping');
}
