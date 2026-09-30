import { pool } from "./pool";
import type { LinkCheckResult } from "../checker/linkChecker";

// error_message es VARCHAR(255) y los errores de Playwright suelen ser mas
// largos (traen el call log): en modo estricto el INSERT fallaria.
const MAX_ERROR_LENGTH = 255;

export async function insertLinkCheck(
  smsContentId: number,
  result: LinkCheckResult
): Promise<void> {
  await pool.query(
    `INSERT INTO sms_link_checks
       (sms_content_id, link, checked_at, http_status, is_ok, response_time_ms, error_message)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      smsContentId,
      result.link,
      result.checkedAt,
      result.httpStatus,
      result.ok ? 1 : 0,
      result.responseTimeMs,
      result.errorMessage?.slice(0, MAX_ERROR_LENGTH) ?? null,
    ]
  );
}
