// Turns an RPC call into SQL for the local PGlite backend, using the function's real argument types.
export type ArgTypes = Record<string, string>

export const signatureSql = `
  select p.proname as name, a.argname, format_type(a.argtype, null) as argtype
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
  left join lateral unnest(p.proargnames, p.proargtypes::oid[]) as a(argname, argtype) on true`

export function toParam(value: unknown, type: string): unknown {
  if (value === undefined || value === null) return null
  if (type === 'jsonb' || type === 'json') return JSON.stringify(value)
  if (type.endsWith('[]')) {
    const items = (value as unknown[]).map((v) => `"${String(v).replace(/(["\\])/g, '\\$1')}"`)
    return `{${items.join(',')}}`
  }
  if (value instanceof Date) return value.toISOString()
  return String(value)
}

export function buildRpcSql(name: string, args: Record<string, unknown>, types: ArgTypes) {
  const keys = Object.keys(args).filter((k) => args[k] !== undefined)
  const params = keys.map((k) => {
    if (!(k in types)) throw new Error(`Unknown argument ${k} for ${name}`)
    return toParam(args[k], types[k])
  })
  const list = keys.map((k, i) => `${k} => $${i + 1}::${types[k]}`).join(', ')
  return { sql: `select public.${name}(${list}) as r`, params }
}

export type RpcError = { code: string; message: string }

// Server errors look like "CODE: human message" (raised in the SQL functions).
export function parseError(e: unknown): RpcError {
  const raw = (e as { message?: string })?.message ?? String(e)
  const m = raw.match(/^([A-Z_]+): ([\s\S]*)$/)
  return m ? { code: m[1], message: m[2] } : { code: 'ERROR', message: raw }
}
