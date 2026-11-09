// A fixed cycle keeps earlier agreements intact and makes this reset idempotent.
export const AGREEMENT_CYCLE = '2026-11-09';
export function currentAgreementPrefix(production) {
 const scope = production === 'written-in-the-dark' ? '' : 'productions/' + production + '/';
 return 'contract-cycles/' + AGREEMENT_CYCLE + '/' + scope + 'agreements/';
}
export const currentAgreementKey = (production, member) => currentAgreementPrefix(production) + member;

export function supersededContractNotice(message) {
 if (message.agreementCycle) return message.agreementCycle !== AGREEMENT_CYCLE;
 if (['Document ready for signature', 'Agreement ready for your signature'].includes(message.subject)) return true;
 return message.subject === 'Waiting on you · Heidi Mikac Films' &&
  /^(?:Prepare an agreement|Prepare the countersignature|Review and send the countersignature|Review the signing request|Review paperwork|Open for Heidi’s signature)\b/.test(message.text || '');
}
