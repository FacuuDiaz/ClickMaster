import { fetchSmsRecords } from "../fetcher/apiClient";
import { extractLink } from "../parser/extractLink";
import { upsertSmsContent } from "../db/smsContentRepo";
import { insertLinkCheck } from "../db/linkChecksRepo";
import { checkLinks, type LinkCheckTarget } from "../checker/linkChecker";
import { sampleByPercentage } from "../checker/sampleTargets";
import { config } from "../config";

export interface SyncSummary {
  fetched: number;
  loaded: number;
  linksFound: number;
  clickPercentage: number;
  linksSelected: number;
  linksChecked: number;
  linksOk: number;
  linksFailed: number;
}

export async function runSync(): Promise<SyncSummary> {
  const records = await fetchSmsRecords();

  const targets: LinkCheckTarget[] = [];

  for (const record of records) {
    const smsContentId = await upsertSmsContent(record);
    const link = extractLink(record.text);
    if (link) {
      targets.push({ smsContentId, link });
    }
  }

  // Solo se le hace click a una muestra aleatoria (CLICK_PERCENTAGE) de los
  // SMS con link; el resto queda cargado en sms_content sin chequear.
  const selected = sampleByPercentage(targets, config.checker.clickPercentage);
  const results = await checkLinks(selected);

  for (const result of results) {
    await insertLinkCheck(result.smsContentId, result);
  }

  return {
    fetched: records.length,
    loaded: records.length,
    linksFound: targets.length,
    clickPercentage: config.checker.clickPercentage,
    linksSelected: selected.length,
    linksChecked: results.length,
    linksOk: results.filter((r) => r.ok).length,
    linksFailed: results.filter((r) => !r.ok).length,
  };
}
