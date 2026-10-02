import { config } from "../config";

export interface ClickListItem {
  url: string;
  count: number;
}

export type ParseClickListResult =
  | { ok: true; items: ClickListItem[] }
  | { ok: false; errors: string[] };

function isValidUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parsea el contenido de un archivo tipo clicks_to_do.txt: una linea por
 * job, con el formato `url,cantidad`. Las lineas vacias y las que empiezan
 * con `#` se ignoran. Se corta por la ULTIMA coma, asi las URLs que traen
 * comas en el query string no se rompen.
 * Si alguna linea es invalida se devuelven todos los errores (con numero de
 * linea) y no se encola nada: mejor rechazar el archivo entero que lanzar
 * solo una parte sin que se note.
 */
export function parseClickList(text: string): ParseClickListResult {
  const items: ClickListItem[] = [];
  const errors: string[] = [];

  text.split(/\r?\n/).forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) return;

    const lineNo = index + 1;
    const comma = line.lastIndexOf(",");
    if (comma === -1) {
      errors.push(`linea ${lineNo}: falta la cantidad (formato url,cantidad): "${line}"`);
      return;
    }

    const url = line.slice(0, comma).trim();
    const countText = line.slice(comma + 1).trim();

    if (!/^https?:\/\/\S+$/i.test(url) || !isValidUrl(url)) {
      errors.push(`linea ${lineNo}: url invalida (tiene que ser http(s)): "${url}"`);
      return;
    }

    const count = Number(countText);
    if (!/^\d+$/.test(countText) || count < 1 || count > config.clicker.maxCount) {
      errors.push(
        `linea ${lineNo}: cantidad invalida "${countText}" (entero entre 1 y ${config.clicker.maxCount})`
      );
      return;
    }

    items.push({ url, count });
  });

  if (errors.length > 0) return { ok: false, errors };
  if (items.length === 0) return { ok: false, errors: ["el archivo no tiene ninguna linea url,cantidad"] };
  return { ok: true, items };
}
