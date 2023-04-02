#!/bin/bash

rm -rf dist
npm run build
cp -a node_modules dist/
cp -a ecosystem.config.cjs dist/
cp -a package.json dist/
cp -a package-lock.json dist/
cp -a config dist/
