/**
 * Probe WorkBuddy's own sign-in endpoints the way the plugin calls them: ask
 * for a state, then read the token endpoint once without signing in. The answer
 * says whether the plugin's "keep waiting" code (11217) is the right one.
 */

const endpoint = 'https://copilot.tencent.com'
const quiet = {
  'x-no-authorization': 'true',
  'x-no-user-id': 'true',
  'x-no-enterprise-id': 'true',
  'x-no-department-info': 'true',
}
const base = {
  accept: 'application/json',
  'content-type': 'application/json',
  'user-agent': 'WorkBuddy/5.9.3',
}

async function call(method, path, headers = {}, body = undefined) {
  const response = await fetch(endpoint + path, {
    method,
    headers: { ...base, ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20000),
  })
  const text = await response.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = undefined
  }
  return { status: response.status, json, text }
}

const state = await call('POST', '/v2/plugin/auth/state?platform=workbuddy', quiet, {})
console.log('state ->', state.status, 'code =', state.json?.code, 'msg =', state.json?.msg ?? state.text.slice(0, 80))
const token = state.json?.data?.state
const authUrl = state.json?.data?.authUrl
console.log('  has state token:', Boolean(token), '· authUrl host:', authUrl ? new URL(authUrl).host : '(none)')

if (token) {
  const polled = await call('GET', `/v2/plugin/auth/token?state=${encodeURIComponent(token)}`)
  console.log('token ->', polled.status, 'code =', polled.json?.code, 'msg =', polled.json?.msg ?? polled.text.slice(0, 80))
  console.log('  data keys:', polled.json?.data ? Object.keys(polled.json.data).join(', ') : '(none)')
  if (polled.json?.data) {
    console.log('  has accessToken:', Boolean(polled.json.data.accessToken), '· has access:', Boolean(polled.json.data.access))
  }
}