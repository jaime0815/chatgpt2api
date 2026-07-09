function normalizeBasePath(value?: string) {
    const trimmed = String(value || '').trim()
    if (!trimmed || trimmed === '/') {
        return ''
    }
    const prefixed = trimmed.startsWith('/') ? trimmed : `/${trimmed}`
    return prefixed.replace(/\/+$/, '')
}

const webConfig = {
    apiUrl: (
        process.env.NEXT_PUBLIC_API_BASE_URL ||
        process.env.NEXT_PUBLIC_API_URL ||
        (process.env.NODE_ENV === 'development' ? 'http://127.0.0.1:8000' : '')
    ).replace(/\/$/, ''),
    basePath: normalizeBasePath(process.env.NEXT_PUBLIC_BASE_PATH || '/chatgpt2api'),
    appVersion: process.env.NEXT_PUBLIC_APP_VERSION || '0.0.0',
}

export default webConfig
