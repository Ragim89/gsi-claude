import type { ServiceType } from './enums';

export interface LocalizedText {
  en: string;
  ru?: string;
  tr?: string;
  [locale: string]: string | undefined;
}

/**
 * check  — result only (OK / deviation / N/A)
 * text   — free-text reading + result
 * number — numeric reading + result
 */
export type ChecklistInputKind = 'check' | 'text' | 'number';

/**
 * Sections keep a phone screen navigable: an inspector works through one block at a time
 * instead of scrolling a flat list of thirty questions in the rain.
 */
export const CHECKLIST_SECTIONS = ['documents', 'vessel', 'cargo', 'operations', 'observations'] as const;
export type ChecklistSection = (typeof CHECKLIST_SECTIONS)[number];

export interface ChecklistTemplateItem {
  key: string;
  kind: ChecklistInputKind;
  label: LocalizedText;
  /** Groups the items into collapsible blocks on the field screen; see CHECKLIST_SECTIONS. */
  section?: ChecklistSection;
  /**
   * Must be answered before the inspection can be completed. Defaults to true, which is what
   * the job flow has always required; a template marks the genuinely optional ones.
   */
  required?: boolean;
}

// ASSUMPTION: GSI has not yet provided its official checklists / methodologies
// (docs/07-open-questions.md #4). These are draft item sets per service type based on
// common GAFTA/FOSFA practice. Each job snapshots its items (label + kind) into
// job_checklist_items at creation, so changing a template later never rewrites
// historic jobs (ISO 17020 traceability).
/**
 * Bumped whenever the item set changes. v2 added sections and the required flag; snapshots
 * taken under v1-draft keep saying v1-draft, which is the point of stamping it on the row.
 */
export const CHECKLIST_TEMPLATE_VERSION = 'v2-draft';

export const CHECKLIST_TEMPLATES: Record<ServiceType, ChecklistTemplateItem[]> = {
  weight_supervision: [
    { key: 'vessel_particulars', kind: 'check', section: 'documents', label: { en: 'Vessel particulars & documents checked', ru: 'Проверены данные и документы судна', tr: 'Gemi bilgileri ve belgeleri kontrol edildi' } },
    { key: 'initial_draft', kind: 'text', section: 'vessel', label: { en: 'Initial draft readings (fwd / mid / aft)', ru: 'Начальные осадки (нос / мидель / корма)', tr: 'İlk draft okumaları (baş / orta / kıç)' } },
    { key: 'ballast_soundings', kind: 'text', section: 'vessel', label: { en: 'Ballast tank soundings', ru: 'Замеры балластных танков', tr: 'Balast tankı iskandilleri' } },
    { key: 'water_density', kind: 'number', section: 'vessel', label: { en: 'Dock water density (t/m³)', ru: 'Плотность забортной воды (т/м³)', tr: 'Liman suyu yoğunluğu (t/m³)' } },
    { key: 'final_draft', kind: 'text', section: 'vessel', label: { en: 'Final draft readings (fwd / mid / aft)', ru: 'Конечные осадки (нос / мидель / корма)', tr: 'Son draft okumaları (baş / orta / kıç)' } },
    { key: 'calculated_quantity', kind: 'number', section: 'cargo', label: { en: 'Calculated cargo quantity (MT)', ru: 'Расчётное количество груза (т)', tr: 'Hesaplanan yük miktarı (MT)' } },
    // A draft survey may involve no weighbridge at all, so this one is not owed an answer.
    { key: 'scale_calibration', kind: 'check', section: 'documents', required: false, label: { en: 'Scale calibration certificate verified', ru: 'Проверен сертификат калибровки весов', tr: 'Kantar kalibrasyon sertifikası doğrulandı' } },
  ],
  quality_supervision: [
    { key: 'contract_spec', kind: 'check', section: 'documents', label: { en: 'Contract specification & documents reviewed', ru: 'Изучены спецификация контракта и документы', tr: 'Kontrat spesifikasyonu ve belgeler incelendi' } },
    { key: 'appearance', kind: 'text', section: 'cargo', label: { en: 'Visual appearance & colour', ru: 'Внешний вид и цвет', tr: 'Görünüş ve renk' } },
    { key: 'odour', kind: 'check', section: 'cargo', label: { en: 'Odour (sound, free of foreign odour)', ru: 'Запах (без посторонних запахов)', tr: 'Koku (yabancı koku yok)' } },
    { key: 'foreign_matter', kind: 'check', section: 'cargo', label: { en: 'Foreign matter / live insects', ru: 'Сорные примеси / живые насекомые', tr: 'Yabancı madde / canlı böcek' } },
    // The quick tester is not in every office's kit; the lab result is the one that counts.
    { key: 'moisture', kind: 'number', section: 'cargo', required: false, label: { en: 'Moisture quick test (%)', ru: 'Экспресс-тест влажности (%)', tr: 'Hızlı nem testi (%)' } },
    { key: 'grading_result', kind: 'text', section: 'observations', label: { en: 'Grading result vs. contract', ru: 'Результат сортировки относительно контракта', tr: 'Kontrata göre sınıflandırma sonucu' } },
  ],
  sampling: [
    { key: 'sampling_method', kind: 'text', section: 'operations', label: { en: 'Sampling method (GAFTA 124 / FOSFA)', ru: 'Метод отбора проб (GAFTA 124 / FOSFA)', tr: 'Numune alma yöntemi (GAFTA 124 / FOSFA)' } },
    { key: 'grain_sample', kind: 'check', section: 'operations', label: { en: 'Grain sample taken', ru: 'Проба зерна отобрана', tr: 'Tahıl numunesi alındı' } },
    { key: 'incremental_count', kind: 'number', section: 'operations', label: { en: 'Number of incremental samples', ru: 'Количество точечных проб', tr: 'Ara numune sayısı' } },
    { key: 'sealing', kind: 'check', section: 'operations', label: { en: 'Samples sealed & labelled', ru: 'Пробы опломбированы и промаркированы', tr: 'Numuneler mühürlendi ve etiketlendi' } },
    { key: 'seal_numbers', kind: 'text', section: 'operations', label: { en: 'Seal numbers', ru: 'Номера пломб', tr: 'Mühür numaraları' } },
    { key: 'distribution', kind: 'text', section: 'documents', label: { en: 'Sample distribution (lab / buyer / seller / retain)', ru: 'Распределение проб (лаборатория / покупатель / продавец / архив)', tr: 'Numune dağıtımı (lab / alıcı / satıcı / şahit)' } },
  ],
  loading_discharge: [
    { key: 'hold_condition', kind: 'check', section: 'vessel', label: { en: 'Hold condition before operations', ru: 'Состояние трюма до начала операций', tr: 'Operasyon öncesi ambar durumu' } },
    { key: 'hatch_seals', kind: 'text', section: 'vessel', label: { en: 'Hatch covers & seals', ru: 'Люковые закрытия и пломбы', tr: 'Ambar kapakları ve mühürler' } },
    { key: 'weather', kind: 'text', section: 'operations', label: { en: 'Weather conditions during operations', ru: 'Погодные условия во время операций', tr: 'Operasyon sırasında hava koşulları' } },
    { key: 'cargo_condition', kind: 'check', section: 'cargo', label: { en: 'Cargo condition during operations', ru: 'Состояние груза во время операций', tr: 'Operasyon sırasında yük durumu' } },
    // Most operations run without one, and an empty field says that as clearly as a tick.
    { key: 'stoppages', kind: 'text', section: 'operations', required: false, label: { en: 'Stoppages / delays', ru: 'Простои / задержки', tr: 'Duraklamalar / gecikmeler' } },
    { key: 'tally_quantity', kind: 'number', section: 'cargo', label: { en: 'Tally / shore scale quantity (MT)', ru: 'Количество по счёту / береговым весам (т)', tr: 'Tally / kara kantarı miktarı (MT)' } },
  ],
  cleanliness: [
    { key: 'previous_cargoes', kind: 'text', section: 'documents', label: { en: 'Previous cargoes verified', ru: 'Проверены предыдущие грузы', tr: 'Önceki yükler doğrulandı' } },
    { key: 'residues', kind: 'check', section: 'vessel', label: { en: 'Free of previous cargo residues', ru: 'Нет остатков предыдущего груза', tr: 'Önceki yük kalıntısı yok' } },
    { key: 'insects', kind: 'check', section: 'vessel', label: { en: 'Free of insects / infestation', ru: 'Нет насекомых / заражённости', tr: 'Böcek / bulaşma yok' } },
    { key: 'odour', kind: 'check', section: 'vessel', label: { en: 'Free of foreign odour', ru: 'Нет посторонних запахов', tr: 'Yabancı koku yok' } },
    { key: 'dry_rust', kind: 'check', section: 'vessel', label: { en: 'Dry, free of loose rust & scale', ru: 'Сухо, без отслаивающейся ржавчины', tr: 'Kuru, gevşek pas ve kabuk yok' } },
    { key: 'verdict', kind: 'check', section: 'observations', label: { en: 'Suitable to load', ru: 'Пригодно к погрузке', tr: 'Yüklemeye uygun' } },
  ],
  fumigation: [
    { key: 'fumigant', kind: 'text', section: 'operations', label: { en: 'Fumigant & dosage', ru: 'Фумигант и дозировка', tr: 'Fumigant ve dozaj' } },
    { key: 'sealing', kind: 'check', section: 'operations', label: { en: 'Area sealed & warning signs posted', ru: 'Зона загерметизирована, знаки выставлены', tr: 'Alan mühürlendi, uyarı levhaları asıldı' } },
    { key: 'exposure_time', kind: 'number', section: 'operations', label: { en: 'Exposure time (h)', ru: 'Время экспозиции (ч)', tr: 'Maruz kalma süresi (sa)' } },
    { key: 'gas_readings', kind: 'text', section: 'observations', label: { en: 'Gas concentration readings (ppm)', ru: 'Замеры концентрации газа (ppm)', tr: 'Gaz konsantrasyonu ölçümleri (ppm)' } },
    { key: 'ventilation', kind: 'check', section: 'operations', label: { en: 'Ventilation & gas-free confirmed', ru: 'Дегазация подтверждена', tr: 'Havalandırma ve gaz-free teyit edildi' } },
  ],
};

/** Service type display names (also used on the report letterhead). */
export const SERVICE_TYPE_LABELS: Record<ServiceType, LocalizedText> = {
  weight_supervision: { en: 'Weight Supervision / Draft Survey', ru: 'Контроль веса / драфт-сюрвей', tr: 'Ağırlık Gözetimi / Draft Survey' },
  quality_supervision: { en: 'Quality Supervision & Grading', ru: 'Контроль качества и сортировка', tr: 'Kalite Gözetimi ve Sınıflandırma' },
  sampling: { en: 'Sampling Services', ru: 'Отбор проб', tr: 'Numune Alma Hizmetleri' },
  loading_discharge: { en: 'Loading & Discharge Supervision', ru: 'Контроль погрузки и выгрузки', tr: 'Yükleme ve Tahliye Gözetimi' },
  cleanliness: { en: 'Cleanliness Supervision', ru: 'Контроль чистоты', tr: 'Temizlik Gözetimi' },
  fumigation: { en: 'Fumigation Services', ru: 'Фумигация', tr: 'Fumigasyon Hizmetleri' },
};

export function localize(text: LocalizedText, locale: string): string {
  return text[locale] ?? text.en;
}
