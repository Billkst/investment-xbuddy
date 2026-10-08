export interface ModelBudgetBucket {
  bucket: string;
  callLimit: number;
  tokenLimit: number;
  expiresAt: number;
}

// CHECK constraints make a rejected bucket fail the whole D1 batch, so a
// minute limit cannot consume a workspace's daily allowance without a call.
export const reserveModelSql = `INSERT INTO model_usage
  (bucket,calls,tokens,expires_at,call_limit,token_limit) VALUES (?,1,?,?,?,?)
  ON CONFLICT(bucket) DO UPDATE SET calls=calls+1,
  tokens=tokens+excluded.tokens, expires_at=excluded.expires_at,
  call_limit=excluded.call_limit, token_limit=excluded.token_limit`;
