#!/bin/bash
# Copy non-TypeScript assets to dist/ after tsc build

# Create necessary directories
mkdir -p dist/modes/interactive/theme
mkdir -p dist/core/export-html/vendor

# Copy theme JSON files
cp src/modes/interactive/theme/*.json dist/modes/interactive/theme/ 2>/dev/null

# Copy core assets
cp src/core/default-models.json dist/core/ 2>/dev/null

# Copy HTML templates and CSS
cp src/core/export-html/template.html dist/core/export-html/ 2>/dev/null
cp src/core/export-html/template.css dist/core/export-html/ 2>/dev/null
cp src/core/export-html/template.js dist/core/export-html/ 2>/dev/null

# Copy vendor assets if they exist
cp src/core/export-html/vendor/*.js dist/core/export-html/vendor/ 2>/dev/null

echo "Assets copied to dist/"