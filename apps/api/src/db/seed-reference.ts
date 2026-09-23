/**
 * Reference data: the cultures GSI inspects and analyses, and the ports / terminals where
 * inspections take place. Idempotent — rows are matched by `code`.
 *
 * ASSUMPTION: the lists below cover the usual GAFTA/FOSFA grain, pulse and oilseed trade the
 * company works with (docs/00-overview.md) and the lab method sets are indicative. GSI should
 * confirm both lists and their method mapping (docs/07-open-questions.md #4); admins can edit
 * them in the app without a deployment.
 */
import { ClientBase } from 'pg';
import { wrapClient } from './db.service';

type Row = {
  code: string;
  group: string;
  en: string;
  ru: string;
  tr: string;
  hs?: string;
  methods?: string[];
};

const COMMODITIES: Row[] = [
  // Cereals
  { code: 'wheat_milling', group: 'cereals', en: 'Milling wheat', ru: 'Пшеница продовольственная', tr: 'Ekmeklik buğday', hs: '1001.99', methods: ['moisture', 'protein', 'gluten', 'test_weight', 'falling_number', 'impurities', 'mycotoxins'] },
  { code: 'wheat_durum', group: 'cereals', en: 'Durum wheat', ru: 'Пшеница твёрдая (дурум)', tr: 'Makarnalık buğday', hs: '1001.19', methods: ['moisture', 'protein', 'vitreousness', 'test_weight', 'impurities'] },
  { code: 'wheat_feed', group: 'cereals', en: 'Feed wheat', ru: 'Пшеница фуражная', tr: 'Yemlik buğday', hs: '1001.99', methods: ['moisture', 'protein', 'impurities', 'mycotoxins'] },
  { code: 'barley_feed', group: 'cereals', en: 'Feed barley', ru: 'Ячмень фуражный', tr: 'Yemlik arpa', hs: '1003.90', methods: ['moisture', 'protein', 'test_weight', 'impurities'] },
  { code: 'barley_malting', group: 'cereals', en: 'Malting barley', ru: 'Ячмень пивоваренный', tr: 'Maltlık arpa', hs: '1003.90', methods: ['moisture', 'protein', 'germination', 'screenings'] },
  { code: 'corn', group: 'cereals', en: 'Corn (maize)', ru: 'Кукуруза', tr: 'Mısır', hs: '1005.90', methods: ['moisture', 'broken_grains', 'aflatoxin', 'gmo', 'impurities'] },
  { code: 'rye', group: 'cereals', en: 'Rye', ru: 'Рожь', tr: 'Çavdar', hs: '1002.90', methods: ['moisture', 'falling_number', 'impurities'] },
  { code: 'oats', group: 'cereals', en: 'Oats', ru: 'Овёс', tr: 'Yulaf', hs: '1004.90', methods: ['moisture', 'test_weight', 'impurities'] },
  { code: 'rice', group: 'cereals', en: 'Rice', ru: 'Рис', tr: 'Pirinç', hs: '1006.30', methods: ['moisture', 'broken_grains', 'impurities'] },
  { code: 'sorghum', group: 'cereals', en: 'Sorghum', ru: 'Сорго', tr: 'Sorgum', hs: '1007.90', methods: ['moisture', 'impurities', 'mycotoxins'] },
  { code: 'millet', group: 'cereals', en: 'Millet', ru: 'Просо', tr: 'Darı', hs: '1008.29', methods: ['moisture', 'impurities'] },
  // Pulses
  { code: 'lentils_red', group: 'pulses', en: 'Red lentils', ru: 'Чечевица красная', tr: 'Kırmızı mercimek', hs: '0713.40', methods: ['moisture', 'foreign_matter', 'damaged_grains', 'pesticides', 'size_grading'] },
  { code: 'lentils_green', group: 'pulses', en: 'Green lentils', ru: 'Чечевица зелёная', tr: 'Yeşil mercimek', hs: '0713.40', methods: ['moisture', 'foreign_matter', 'damaged_grains', 'pesticides', 'size_grading'] },
  { code: 'peas_yellow', group: 'pulses', en: 'Yellow peas', ru: 'Горох жёлтый', tr: 'Sarı bezelye', hs: '0713.10', methods: ['moisture', 'foreign_matter', 'damaged_grains', 'protein', 'pesticides'] },
  { code: 'peas_green', group: 'pulses', en: 'Green peas', ru: 'Горох зелёный', tr: 'Yeşil bezelye', hs: '0713.10', methods: ['moisture', 'foreign_matter', 'damaged_grains', 'protein'] },
  { code: 'chickpeas', group: 'pulses', en: 'Chickpeas', ru: 'Нут', tr: 'Nohut', hs: '0713.20', methods: ['moisture', 'foreign_matter', 'size_grading', 'pesticides'] },
  { code: 'beans', group: 'pulses', en: 'Beans', ru: 'Фасоль', tr: 'Fasulye', hs: '0713.33', methods: ['moisture', 'foreign_matter', 'damaged_grains'] },
  { code: 'vetch', group: 'pulses', en: 'Vetch', ru: 'Вика', tr: 'Fiğ', hs: '0713.90', methods: ['moisture', 'foreign_matter'] },
  // Oilseeds
  { code: 'sunflower_seed', group: 'oilseeds', en: 'Sunflower seed', ru: 'Семена подсолнечника', tr: 'Ayçiçeği tohumu', hs: '1206.00', methods: ['moisture', 'oil_content', 'impurities', 'free_fatty_acids'] },
  { code: 'flax_linseed', group: 'oilseeds', en: 'Flaxseed (linseed)', ru: 'Лён (семена льна)', tr: 'Keten tohumu', hs: '1204.00', methods: ['moisture', 'oil_content', 'impurities', 'pesticides'] },
  { code: 'rapeseed', group: 'oilseeds', en: 'Rapeseed / canola', ru: 'Рапс', tr: 'Kanola', hs: '1205.10', methods: ['moisture', 'oil_content', 'erucic_acid', 'glucosinolates', 'gmo'] },
  { code: 'soybean', group: 'oilseeds', en: 'Soybeans', ru: 'Соя', tr: 'Soya fasulyesi', hs: '1201.90', methods: ['moisture', 'protein', 'oil_content', 'gmo', 'mycotoxins'] },
  { code: 'sesame', group: 'oilseeds', en: 'Sesame seed', ru: 'Кунжут', tr: 'Susam', hs: '1207.40', methods: ['moisture', 'oil_content', 'salmonella', 'pesticides'] },
  { code: 'mustard_seed', group: 'oilseeds', en: 'Mustard seed', ru: 'Горчица (семена)', tr: 'Hardal tohumu', hs: '1207.50', methods: ['moisture', 'oil_content', 'impurities'] },
  { code: 'safflower', group: 'oilseeds', en: 'Safflower seed', ru: 'Сафлор', tr: 'Aspir', hs: '1207.60', methods: ['moisture', 'oil_content'] },
  { code: 'cotton_seed', group: 'oilseeds', en: 'Cotton seed', ru: 'Семена хлопчатника', tr: 'Çiğit', hs: '1207.29', methods: ['moisture', 'oil_content', 'gossypol'] },
  // Vegetable oils
  { code: 'sunflower_oil', group: 'vegetable_oils', en: 'Sunflower oil (crude)', ru: 'Масло подсолнечное (сырое)', tr: 'Ham ayçiçek yağı', hs: '1512.11', methods: ['free_fatty_acids', 'peroxide_value', 'moisture_volatile', 'colour', 'phosphorus'] },
  { code: 'soybean_oil', group: 'vegetable_oils', en: 'Soybean oil', ru: 'Масло соевое', tr: 'Soya yağı', hs: '1507.10', methods: ['free_fatty_acids', 'peroxide_value', 'moisture_volatile'] },
  { code: 'rapeseed_oil', group: 'vegetable_oils', en: 'Rapeseed oil', ru: 'Масло рапсовое', tr: 'Kanola yağı', hs: '1514.11', methods: ['free_fatty_acids', 'peroxide_value', 'erucic_acid'] },
  // Meals and cakes
  { code: 'soybean_meal', group: 'meals_cakes', en: 'Soybean meal', ru: 'Шрот соевый', tr: 'Soya küspesi', hs: '2304.00', methods: ['moisture', 'protein', 'fibre', 'urease', 'gmo'] },
  { code: 'sunflower_meal', group: 'meals_cakes', en: 'Sunflower meal', ru: 'Шрот подсолнечный', tr: 'Ayçiçeği küspesi', hs: '2306.30', methods: ['moisture', 'protein', 'fibre', 'oil_content'] },
  { code: 'rapeseed_meal', group: 'meals_cakes', en: 'Rapeseed meal', ru: 'Шрот рапсовый', tr: 'Kanola küspesi', hs: '2306.41', methods: ['moisture', 'protein', 'fibre'] },
  { code: 'ddgs', group: 'meals_cakes', en: 'DDGS', ru: 'Барда сухая (DDGS)', tr: 'DDGS', hs: '2303.30', methods: ['moisture', 'protein', 'mycotoxins'] },
  // Fertilizers and other
  { code: 'urea', group: 'fertilizers', en: 'Urea', ru: 'Карбамид', tr: 'Üre', hs: '3102.10', methods: ['moisture', 'biuret', 'granulometry'] },
  { code: 'ammonium_nitrate', group: 'fertilizers', en: 'Ammonium nitrate', ru: 'Аммиачная селитра', tr: 'Amonyum nitrat', hs: '3102.30', methods: ['moisture', 'nitrogen', 'granulometry'] },
  { code: 'sugar', group: 'other', en: 'Sugar', ru: 'Сахар', tr: 'Şeker', hs: '1701.99', methods: ['moisture', 'polarisation', 'colour'] },
  { code: 'other', group: 'other', en: 'Other cargo', ru: 'Прочий груз', tr: 'Diğer yük', methods: [] },
];

const PORTS: { code: string; name: string; country: string; inland?: boolean }[] = [
  // Türkiye
  { code: 'TRDRC', name: 'Derince', country: 'TR' },
  { code: 'TRMER', name: 'Mersin', country: 'TR' },
  { code: 'TRIZM', name: 'İzmir (Alsancak)', country: 'TR' },
  { code: 'TRTEK', name: 'Tekirdağ (Akport)', country: 'TR' },
  { code: 'TRIST', name: 'İstanbul (Ambarlı)', country: 'TR' },
  { code: 'TRBAN', name: 'Bandırma', country: 'TR' },
  { code: 'TRSSX', name: 'Samsun', country: 'TR' },
  // Romania
  { code: 'ROCND', name: 'Constanța', country: 'RO' },
  { code: 'ROGAL', name: 'Galați', country: 'RO' },
  // Ukraine
  { code: 'UAODS', name: 'Odesa', country: 'UA' },
  { code: 'UAPDV', name: 'Pivdennyi', country: 'UA' },
  { code: 'UACHN', name: 'Chornomorsk', country: 'UA' },
  // Russia
  { code: 'RUNVS', name: 'Новороссийск', country: 'RU' },
  { code: 'RUTMN', name: 'Тамань', country: 'RU' },
  { code: 'RUROV', name: 'Ростов-на-Дону', country: 'RU' },
  { code: 'RUAZO', name: 'Азов', country: 'RU' },
  // Kazakhstan / Uzbekistan (inland terminals and the Caspian)
  { code: 'KZAKU', name: 'Aktau', country: 'KZ' },
  { code: 'KZAST', name: 'Astana elevator', country: 'KZ', inland: true },
  { code: 'UZTAS', name: 'Tashkent terminal', country: 'UZ', inland: true },
  { code: 'UZSRG', name: 'Sergeli warehouse', country: 'UZ', inland: true },
  // UAE
  { code: 'AERKT', name: 'Ras Al Khaimah', country: 'AE' },
  { code: 'AEJEA', name: 'Jebel Ali', country: 'AE' },
  // Italy
  { code: 'ITRAN', name: 'Ravenna', country: 'IT' },
  { code: 'ITVCE', name: 'Venice', country: 'IT' },
];

export async function seedReference(client: ClientBase): Promise<void> {
  const tx = wrapClient(client);

  for (const [i, c] of COMMODITIES.entries()) {
    await tx.exec(
      `INSERT INTO commodities (code, "group", name, hs_code, lab_methods, sort_order)
       VALUES ($1, $2::commodity_group, $3::jsonb, $4, $5::text[], $6)
       ON CONFLICT (code) DO UPDATE
         SET name = EXCLUDED.name, "group" = EXCLUDED."group", hs_code = EXCLUDED.hs_code,
             lab_methods = EXCLUDED.lab_methods, sort_order = EXCLUDED.sort_order`,
      [c.code, c.group, JSON.stringify({ en: c.en, ru: c.ru, tr: c.tr }), c.hs ?? null, c.methods ?? [], (i + 1) * 10],
    );
  }

  for (const p of PORTS) {
    await tx.exec(
      `INSERT INTO ports (code, name, country, is_inland) VALUES ($1, $2, $3, $4)
       ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, country = EXCLUDED.country`,
      [p.code, p.name, p.country, p.inland ?? false],
    );
  }

  // Link the demo jobs created before this reference existed: match the free-text commodity
  // and location, and pull a numeric volume out of strings like "25,000 MT ±10%".
  await tx.exec(
    `UPDATE inspection_jobs j SET commodity_id = c.id
     FROM commodities c
     WHERE j.commodity_id IS NULL AND j.commodity IS NOT NULL
       AND lower(c.name->>'en') = lower(j.commodity)`,
  );
  await tx.exec(
    `UPDATE inspection_jobs j SET port_id = p.id
     FROM ports p
     WHERE j.port_id IS NULL AND j.location ILIKE '%' || p.name || '%'`,
  );
  await tx.exec(
    `UPDATE inspection_jobs SET quantity_value = NULLIF(regexp_replace(quantity, '[^0-9]', '', 'g'), '')::numeric
     WHERE quantity_value IS NULL AND quantity ~ '[0-9]'`,
  );
  // Demo jobs were created with a handful of free-text commodities; spread the ones that did
  // not match across the whole reference so the filters have realistic variety.
  await tx.exec(
    `WITH pool AS (
       SELECT id, row_number() OVER (ORDER BY sort_order) - 1 AS n, count(*) OVER () AS total
       FROM commodities WHERE code <> 'other'
     )
     UPDATE inspection_jobs j SET commodity_id = pool.id
     FROM pool
     WHERE j.commodity_id IS NULL
       AND pool.n = abs(hashtext(j.id::text)) % pool.total`,
  );
  // Contract numbers were not part of the earlier demo data; derive a plausible one.
  await tx.exec(
    `UPDATE inspection_jobs SET contract_no = 'CT-' || to_char(created_at, 'YYYY') || '-' ||
            lpad((abs(hashtext(id::text)) % 9000 + 1000)::text, 4, '0')
     WHERE contract_no IS NULL`,
  );

  const counts = await tx.one<{ c: number; p: number }>(
    `SELECT (SELECT count(*) FROM commodities)::int AS c, (SELECT count(*) FROM ports)::int AS p`,
  );
  console.log(`reference data: ${counts?.c} commodities, ${counts?.p} ports`);
}
