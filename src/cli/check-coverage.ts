import { closeSqlServerPool, measureUnitCoverage, fetchDocumentsSince } from '../etl/sqlserver';
import { extractEcoNumbers, extractFolios } from '../domain/normalize';

/**
 * Diagnóstico previo a confiar en el validador.
 *
 * R1 (unidad discordante) y R3 (multi-unidad) son el grueso del valor, y
 * dependen por completo de que el ERP traiga la unidad capturada. Este script
 * responde: ¿ese dato existe y en qué proporción?
 *
 *   npm run check:coverage
 *
 * Solo LEE de AdminPAQ. No escribe nada, en ningún lado.
 */

function pct(part: number, total: number): string {
  if (total === 0) return '0.0%';
  return `${((part / total) * 100).toFixed(1)}%`;
}

function bar(value: number, total: number, width = 32): string {
  const filled = total === 0 ? 0 : Math.round((value / total) * width);
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled));
}

async function main(): Promise<void> {
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  Diagnóstico de cobertura — AdminPAQ');
  console.log('═══════════════════════════════════════════════════════════\n');

  // 1. Conteos globales, resueltos del lado de SQL Server.
  const coverage = await measureUnitCoverage();

  console.log('Documentos NO cancelados:', coverage.total.toLocaleString('es-MX'));
  console.log();
  console.log(`  Con folio (extra_text_three)   ${bar(coverage.withFolio, coverage.total)}  ${pct(coverage.withFolio, coverage.total)}`);
  console.log(`  Con unidad (extra_text_two)    ${bar(coverage.withUnitTwo, coverage.total)}  ${pct(coverage.withUnitTwo, coverage.total)}`);
  console.log(`  Con texto en extra_text_one    ${bar(coverage.withUnitOne, coverage.total)}  ${pct(coverage.withUnitOne, coverage.total)}`);
  console.log(`  Con alguna unidad              ${bar(coverage.withAnyUnit, coverage.total)}  ${pct(coverage.withAnyUnit, coverage.total)}`);
  console.log();

  // 2. Muestreo: tener texto no es lo mismo que tener un eco reconocible.
  console.log('Analizando el contenido real de los campos…\n');
  const docs = await fetchDocumentsSince(null);

  const withFolioText = docs.filter(
    (d) => d.CTEXTOEXTRA3 && d.CTEXTOEXTRA3.trim() !== '' && d.CCANCELADO === 0,
  );

  let parseableFolio = 0;
  let ambiguousFolio = 0;
  let multiFolio = 0;
  let resolvableUnit = 0;
  let multiUnit = 0;
  let stockMentions = 0;

  for (const d of withFolioText) {
    const folios = extractFolios(d.CTEXTOEXTRA3);
    if (folios.candidates.length > 0) parseableFolio++;
    if (folios.ambiguous) ambiguousFolio++;
    if (folios.multiple) multiFolio++;

    const eco = extractEcoNumbers(d.CTEXTOEXTRA2 ?? d.CTEXTOEXTRA1);
    if (eco.ecoNumbers.length > 0) resolvableUnit++;
    if (eco.ecoNumbers.length > 1) multiUnit++;
    if (eco.mentionsStock) stockMentions++;
  }

  const base = withFolioText.length;

  console.log(`Documentos con folio capturado: ${base.toLocaleString('es-MX')}\n`);
  console.log(`  Folio interpretable            ${pct(parseableFolio, base)}  (${parseableFolio.toLocaleString('es-MX')})`);
  console.log(`  Folio AMBIGUO (sin prefijo)    ${pct(ambiguousFolio, base)}  (${ambiguousFolio.toLocaleString('es-MX')})  → R5`);
  console.log(`  Folio múltiple                 ${pct(multiFolio, base)}  (${multiFolio.toLocaleString('es-MX')})`);
  console.log();
  console.log(`  Unidad reconocible             ${pct(resolvableUnit, base)}  (${resolvableUnit.toLocaleString('es-MX')})  → viabilidad de R1`);
  console.log(`  Declara varias unidades        ${pct(multiUnit, base)}  (${multiUnit.toLocaleString('es-MX')})  → R3`);
  console.log(`  Menciona stock/almacén         ${pct(stockMentions, base)}  (${stockMentions.toLocaleString('es-MX')})  → R2`);
  console.log();

  // 3. Veredicto sobre la viabilidad de la regla principal.
  const r1Viability = base === 0 ? 0 : (resolvableUnit / base) * 100;

  console.log('───────────────────────────────────────────────────────────');
  if (r1Viability >= 80) {
    console.log(`✓ R1 es viable: ${r1Viability.toFixed(1)}% de los documentos con folio`);
    console.log('  traen unidad reconocible. La regla principal puede aplicarse.');
  } else if (r1Viability >= 40) {
    console.log(`⚠ R1 es parcial: solo ${r1Viability.toFixed(1)}% trae unidad reconocible.`);
    console.log('  La regla sirve, pero dejará sin evaluar a buena parte de los');
    console.log('  documentos. Conviene reforzar la captura en el ERP.');
  } else {
    console.log(`✗ R1 NO es viable hoy: solo ${r1Viability.toFixed(1)}% trae unidad.`);
    console.log('  Hay que apoyarse en el eco de los movimientos o en la unidad');
    console.log('  del folio antes de confiar en esta regla.');
  }
  console.log('───────────────────────────────────────────────────────────\n');

  // 4. Ejemplos concretos, para ver con qué se está lidiando.
  const samples = withFolioText.slice(0, 8);
  if (samples.length > 0) {
    console.log('Muestra de capturas reales:\n');
    for (const d of samples) {
      const folios = extractFolios(d.CTEXTOEXTRA3);
      const eco = extractEcoNumbers(d.CTEXTOEXTRA2 ?? d.CTEXTOEXTRA1);
      console.log(`  doc ${d.CIDDOCUMENTO}`);
      console.log(`    folio ERP : ${JSON.stringify(d.CTEXTOEXTRA3)} → ${folios.candidates.map((c) => c.pid).join(', ') || '(no interpretable)'}`);
      console.log(`    unidad    : ${JSON.stringify(d.CTEXTOEXTRA2)} → ${eco.ecoNumbers.join(', ') || '(no interpretable)'}`);
    }
    console.log();
  }
}

main()
  .then(() => closeSqlServerPool())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error('\nError en el diagnóstico:', err instanceof Error ? err.message : err);
    await closeSqlServerPool().catch(() => undefined);
    process.exit(1);
  });
