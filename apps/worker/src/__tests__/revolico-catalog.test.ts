import { describe, expect, it } from "vitest";
import { extractListingUrls, parseOwnedListingHtml, shouldWriteCatalogStatus } from "../revolico-catalog";

const url = "https://revolico-sagua.pages.dev/anuncio/a1b1aa34-ccc3-44d6-9e25-ebb7d55624a5";
const validHtml = `
<article>
  <div class="tag">Telefonía</div>
  <h1 class="h1">SAMSUNG GALAXY A17 — 4GB RAM / 128GB ROM</h1>
  <div class="price">200 USD</div>
  <div class="muted">Sagua la Grande · Nuevo</div>
  <div class="desc">Pantalla AMOLED &amp; batería de 5000 mAh.</div>
  <div class="facts">
    <p><strong>Estado:</strong> Publicado y vigente al consultar esta ficha.</p>
    <p><strong>Vigencia del anuncio hasta:</strong> 23 de noviembre de 2026</p>
    <p><strong>Disponibilidad indicada:</strong> Disponible</p>
    <p><strong>Entrega:</strong> Servicio a domicilio sin costo adicional</p>
  </div>
  <a href="https://wa.me/5354590237?text=hola">Contactar por WhatsApp</a>
</article>`;

describe("Revolico public catalog import safety", () => {
  it("does not rewrite an unchanged status on every five-minute cron tick", () => {
    const current = {
      stage: "workspace_missing",
      message: "No se encontró el espacio de trabajo de Cell Phone Store.",
      updatedAt: "2026-11-23T12:00:00.000Z",
      workspaceMatches: 0,
    };
    expect(shouldWriteCatalogStatus(current, {
      stage: current.stage,
      message: current.message,
      workspaceMatches: 0,
    }, Date.parse("2026-11-23T12:05:00.000Z"))).toBe(false);
    expect(shouldWriteCatalogStatus(current, {
      stage: "error",
      message: "Error distinto",
      workspaceMatches: 0,
    }, Date.parse("2026-11-23T12:05:00.000Z"))).toBe(true);
    expect(shouldWriteCatalogStatus(current, {
      stage: current.stage,
      message: current.message,
      workspaceMatches: 0,
    }, Date.parse("2026-11-23T18:01:00.000Z"))).toBe(true);
  });

  it("extracts only same-site listing detail URLs", () => {
    const html = `<a href="${url}">ad</a><a href="https://evil.example/anuncio/12345678-1234-1234-1234-123456789abc">bad</a>`;
    expect(extractListingUrls(html)).toEqual([url]);
  });

  it("imports a current listing only when its WhatsApp number matches the store", () => {
    const item = parseOwnedListingHtml(url, validHtml, Date.parse("2026-11-21T12:00:00Z"));
    expect(item?.title).toBe("SAMSUNG GALAXY A17 — 4GB RAM / 128GB ROM");
    expect(item?.price).toBe("200 USD");
    expect(item?.status).toBe("Disponible");
    expect(item?.delivery).toBe("Servicio a domicilio sin costo adicional");
    expect(item?.description).toContain("batería de 5000 mAh.");
  });

  it("accepts the current public MikroTik listing format for automatic catalog ingestion", () => {
    const mikrotikUrl = "https://revolico-sagua.pages.dev/anuncio/1e9e09a5-301e-47fb-8c3a-b9254141d234";
    const mikrotikHtml = validHtml
      .replace("Telefonía", "Otros")
      .replace("SAMSUNG GALAXY A17 — 4GB RAM / 128GB ROM", "MikroTik SXT Lite5 | Solución inalámbrica de exterior")
      .replace("200 USD", "150 USD")
      .replace("Pantalla AMOLED &amp; batería de 5000 mAh.", "Disponible MikroTik SXT Lite5, equipo inalámbrico de exterior para enlaces de red.")
      .replace("23 de noviembre de 2026", "3 de diciembre de 2026");
    const item = parseOwnedListingHtml(mikrotikUrl, mikrotikHtml, Date.parse("2026-11-26T18:00:00Z"));
    expect(item?.title).toContain("MikroTik SXT Lite5");
    expect(item?.price).toBe("150 USD");
    expect(item?.status).toBe("Disponible");
    expect(item?.description).toContain("MikroTik SXT Lite5");
  });

  it("preserves bullet and line boundaries in a public listing description", () => {
    const ecoflowHtml = validHtml.replace(
      '<div class="desc">Pantalla AMOLED &amp; batería de 5000 mAh.</div>',
      '<div class="desc">Especificaciones destacadas: · Capacidad: 1024 Wh (1 kWh) · Potencia: 1800 W continuos / hasta 2700 W pico con X-Boost · Batería LiFePO4: más de 3000 ciclos de carga · Carga solar: admite hasta 500 W · Carga ultrarrápida: 0–80 % en aproximadamente 50 minutos · Control inteligente: Wi-Fi y Bluetooth con la app EcoFlow</div>',
    );
    const item = parseOwnedListingHtml(url, ecoflowHtml, Date.parse("2026-11-21T12:00:00Z"));
    expect(item?.description).toContain("\n- Capacidad: 1024 Wh");
    expect(item?.description).toContain("\n- Potencia: 1800 W continuos");
    expect(item?.description).toContain("\n- Carga solar: admite hasta 500 W");
    expect(item?.description).toContain("\n- Control inteligente: Wi-Fi y Bluetooth");
  });
  it("never imports another seller's listing", () => {
    const foreign = validHtml.replace("wa.me/5354590237", "wa.me/5355555555");
    expect(parseOwnedListingHtml(url, foreign, Date.parse("2026-11-21T12:00:00Z"))).toBeNull();
  });

  it("excludes expired, unpublished, and unknown-status listings", () => {
    const expired = validHtml.replace("23 de noviembre de 2026", "20 de noviembre de 2026");
    const unpublished = validHtml.replace("Publicado y vigente", "Retirado");
    const unknown = validHtml.replace("Disponible</p>", "En revisión</p>");
    const now = Date.parse("2026-11-21T12:00:00Z");
    expect(parseOwnedListingHtml(url, expired, now)).toBeNull();
    expect(parseOwnedListingHtml(url, unpublished, now)).toBeNull();
    expect(parseOwnedListingHtml(url, unknown, now)).toBeNull();
  });

  it("preserves por encargo and próximamente as distinct statuses", () => {
    expect(parseOwnedListingHtml(url, validHtml.replace("Disponible</p>", "Por encargo</p>"), Date.parse("2026-11-21T12:00:00Z"))?.status).toBe("Por encargo");
    expect(parseOwnedListingHtml(url, validHtml.replace("Disponible</p>", "Próximamente</p>"), Date.parse("2026-11-21T12:00:00Z"))?.status).toBe("Próximamente");
  });

  it("fails closed when the expiry date or contact link is missing", () => {
    expect(parseOwnedListingHtml(url, validHtml.replace("23 de noviembre de 2026", "fecha desconocida"), Date.parse("2026-11-21T12:00:00Z"))).toBeNull();
    expect(parseOwnedListingHtml(url, validHtml.replace(/<a href="https:\/\/wa\.me\/5354590237[^"]*">[\s\S]*?<\/a>/, ""), Date.parse("2026-11-21T12:00:00Z"))).toBeNull();
  });
});
