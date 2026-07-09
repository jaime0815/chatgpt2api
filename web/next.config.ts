import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { NextConfig } from 'next'
import { parseChangelog } from './src/lib/release'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const defaultBasePath = '/chatgpt2api'

function normalizeBasePath(value: string | undefined) {
    const trimmed = String(value || '').trim()
    if (!trimmed || trimmed === '/') {
        return ''
    }
    const prefixed = trimmed.startsWith('/') ? trimmed : `/${trimmed}`
    return prefixed.replace(/\/+$/, '')
}

function readAppVersion() {
    try {
        const version = readFileSync(join(projectRoot, 'VERSION'), 'utf-8').trim()
        return version || '0.0.0'
    } catch {
        return '0.0.0'
    }
}

const appVersion = process.env.NEXT_PUBLIC_APP_VERSION || readAppVersion()
const appBasePath = normalizeBasePath(process.env.NEXT_PUBLIC_BASE_PATH || process.env.CHATGPT2API_WEB_BASE_PATH || defaultBasePath)
let appReleases = '[]'
try {
    appReleases = JSON.stringify(parseChangelog(readFileSync(join(projectRoot, 'CHANGELOG.md'), 'utf-8')))
} catch {}

const nextConfig: NextConfig = {
    allowedDevOrigins: ['127.0.0.1'],
    env: {
        NEXT_PUBLIC_APP_VERSION: appVersion,
        NEXT_PUBLIC_APP_RELEASES: appReleases,
        NEXT_PUBLIC_BASE_PATH: appBasePath,
    },
    ...(appBasePath ? { basePath: appBasePath } : {}),
    output: 'export',
    trailingSlash: true,
    images: {
        unoptimized: true,
    },
    typescript: {
        ignoreBuildErrors: true,
    },
}

export default nextConfig
