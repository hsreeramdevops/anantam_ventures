import { CATEGORIES } from '../schema';

type Category = (typeof CATEGORIES)[number];

/** Ordered: first match wins. Free, deterministic, no LLM cost. */
const RULES: [Category, RegExp][] = [
  ['Cement', /\b(cement|opc|ppc|ultratech|acc|ambuja|ramco|dalmia|birla|jk ?lakshmi|chettinad|zuari|bharathi|concrete|rmc|ready ?mix)\b/i],
  ['Steel', /\b(steel|tmt|rebar|bars?|fe ?5\d\d|jsw|tata tiscon|sail|vizag|binding wire|rod)\b/i],
  ['Sand & Aggregates', /\b(sand|m[- ]?sand|p[- ]?sand|aggregate|jelly|gravel|metal \d|stone ?dust|crusher|boulder)\b/i],
  ['Bricks & Blocks', /\b(brick|blocks?|aac|fly ?ash|hollow block|solid block|siporex)\b/i],
  ['Electrical', /\b(electric|wire|wiring|cable|switch|mcb|db box|conduit|havells|finolex|polycab|anchor|legrand|lighting|led)\b/i],
  ['Plumbing & Sanitary', /\b(plumb|pipe|cpvc|upvc|pvc|sanitary|faucet|tap|jaguar|hindware|cera|kohler|ashirvad|astral|supreme|tank|valve|commode|wash ?basin)\b/i],
  ['Tiles & Flooring', /\b(tiles?|vitrified|granite|marble|kajaria|somany|johnson|flooring|skirting|grout|tile adhesive)\b/i],
  ['Paint', /\b(paint|putty|primer|emulsion|asian paints|berger|nerolac|dulux|nippon|birla white|waterproof(ing)?|dr\.? ?fixit)\b/i],
  ['Wood & Doors', /\b(wood|timber|plywood|ply|teak|doors?|frames?|shutter|laminate|veneer|carpentry)\b/i],
  ['Glass & Aluminium', /\b(glass|aluminium|aluminum|upvc window|glazing|railing)\b/i],
  ['Hardware', /\b(hardware|hinges?|locks?|bolts?|nails?|screws?|tools?|fasteners?)\b/i],
  ['Machinery & Equipment Rent', /\b(rent(al)?|hire|jcb|excavator|crane|mixer|vibrator|scaffold(ing)?|shuttering|centering|generator|dg set)\b/i],
  ['Transport', /\b(transport|freight|lorry|truck|tipper|logistics|delivery charges?|cartage|unloading|loading)\b/i],
  ['Labour & Contractor', /\b(labou?r|contractor|mason|wages?|manpower|work order|piece ?work)\b/i],
  ['Approvals & Legal', /\b(approval|permit|noc|rera|municipal|corporation|panchayat|stamp|registration|legal|advocate|lawyer|court)\b/i],
  ['Professional Fees', /\b(architect|engineer(ing)? fees?|consultan|structural|survey|soil test|design fee|audit fee|ca fee)\b/i],
  ['Utilities', /\b(electricity|power bill|water bill|bescom|tneb|kseb|mseb|tata power|internet|broadband|mobile bill)\b/i],
  ['Marketing', /\b(marketing|advert|hoarding|brochure|banner|flex|digital ads?|google ads|facebook ads|99acres|magicbricks|housing\.com)\b/i],
  ['Office & Admin', /\b(stationery|office|printer|xerox|courier|tea|refreshments?|furniture|computer|software)\b/i],
];

export function categorize(text: string, vendorDefault?: string | null): Category {
  if (vendorDefault && (CATEGORIES as readonly string[]).includes(vendorDefault)) return vendorDefault as Category;
  for (const [cat, re] of RULES) if (re.test(text)) return cat;
  return 'Miscellaneous';
}

export const normalizeName = (s: string) => s.toLowerCase().replace(/\b(m\/s|pvt|private|ltd|limited|llp|co|company|&|and)\b/g, '').replace(/[^a-z0-9]/g, '');
