#!/usr/bin/env node
'use strict'
/**
 * Minimal stand-in for the real zcode CLI entry in Face B tests. It exists to
 * prove one fact: whether the engine handed the child a provider config before
 * spawning it. The real entry exits 0 with an empty stdout when it cannot locate
 * one, so the environment is the only observable that distinguishes "never
 * started properly" from "started".
 */
const config = process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE
process.stdout.write(config === undefined || config.length === 0
  ? 'fake-faceb-zcode: started with NO provider config\n'
  : `fake-faceb-zcode: started with provider config\n`)
process.exit(0)
