// All LLM prompt builders. System prompts are written in the session language.
const { phraseText } = require('../acronym/phrase');

const BRANCHES = ['who', 'what', 'how', 'why'];

// Connectors shown to the model; each must be in normalize.CONNECTORS (checked by tests).
const CONNECTOR_EXAMPLES = {
  fr: 'de, des, du, d’, la, le, les, l’, au, aux, à, en, et, ou, pour, par, sur, sous, avec, sans',
  en: 'of, and, for, the, in, on, to, with, by, at',
};

const QUESTIONS = {
  fr: {
    who: 'De qui ou de quoi s’agit-il ?',
    what: 'Que fait le projet ?',
    how: 'Comment cela fonctionne-t-il ?',
    why: 'Pourquoi ce projet ? Quel problème résout-il ?',
  },
  en: {
    who: 'Who or what is it?',
    what: 'What does it do?',
    how: 'How does it work?',
    why: 'Why does it exist? What problem does it solve?',
  },
};

const T = {
  fr: {
    system:
      "Tu es un expert en naming qui aide à trouver un acronyme pour un projet. Tu réponds uniquement en JSON valide, en français.",
    context: 'Contexte du projet',
    empty: '(pas de réponse)',
    branchTask: (branch, q, a, existing) =>
      `Branche à développer : « ${q} »\nRéponse : « ${a} »\n` +
      (existing.length ? `Mots déjà présents (ne pas répéter) : ${existing.join(', ')}\n` : '') +
      '\nDonne 8 à 12 mots en français pour cette branche, tirés de cette réponse : d’abord les noms et adjectifs clés que la réponse emploie elle-même ' +
      '(les choses, actions, personnes et qualités qu’elle nomme), puis des synonymes simples de ces mots. ' +
      'Reste concret et littéral : chaque mot doit faire penser à ce projet précis, pas à n’importe quel projet. ' +
      'Transforme les expressions en un seul nom ou adjectif (ex. « décourage » → Lassitude, « garder les idées privées » → Confidentialité) ; ' +
      'ne recopie jamais une phrase entière. Évite les mots vagues et génériques qui pourraient décrire n’importe quelle marque ou n’importe quel projet, ' +
      'et laisse de côté ce que le projet rejette ou remplace. ' +
      'Des mots simples ou de très courtes expressions nominales (2 mots maximum). ' +
      (branch === 'who'
        ? 'Inclus 3 ou 4 noms de catégorie adaptés à ce projet, qui disent ce qu’il est et peuvent ouvrir son nom (par ex. pour une application : Application, Plateforme, Outil). '
        : branch === 'why'
          ? 'Pour cette branche, nomme le résultat et les bénéfices que le projet apporte, pas les problèmes qu’il résout : sinon les noms diraient le contraire du projet. '
          : '') +
      "Pas d'articles ni de mots de liaison, pas de doublons, chaque mot commence par une majuscule.\n" +
      'Format : {"words": ["...", "..."]}',
    wordTask: (q, seed, existing) =>
      `Branche : « ${q} »\nMot de départ : « ${seed} »\n` +
      (existing.length ? `Mots déjà présents (ne pas répéter) : ${existing.join(', ')}\n` : '') +
      `\nDonne 6 à 8 mots en français proches de « ${seed} », dans le sens qu’il a dans les réponses de ce projet : ` +
      'des synonymes simples, ou les choses concrètes qu’il désigne ici. Reste concret : chaque mot doit faire penser à ce projet précis. ' +
      'Évite les mots vagues et génériques qui pourraient décrire n’importe quelle marque ou n’importe quel projet. ' +
      "Noms ou adjectifs, mots simples ou expressions de 2 mots maximum, sans articles ni mots de liaison, avec une majuscule.\n" +
      'Format : {"words": ["...", "..."]}',
    composeTask: (min, max, perBranch, chunks) =>
      'À partir des mots ci-dessus (identifiants w1, w2, …), écris 12 noms complets différents pour ce projet. ' +
      'Chacun est une phrase nominale française correcte et logique qui dit ce qu’est ou ce que fait le projet, ' +
      'comme « Régie Autonome des Transports Parisiens » dit ce qu’est la RATP : on doit comprendre le projet en lisant le nom seul.\n' +
      'Règles :\n' +
      '- Pars d’un nom principal (souvent un mot [Qui]) et relie les autres mots comme adjectifs accordés ou compléments ' +
      'introduits par de, des, pour, à… ; jamais une liste de mots-clés ni une énumération.\n' +
      '- Utilise seulement des mots de la liste, chacun une fois au plus ; tu peux changer sa forme (Initiales → Initiale) ' +
      'en gardant sa racine, son sens et sa première lettre.\n' +
      `- Entre eux, ajoute seulement des mots de liaison, qui ne portent jamais de lettre (${CONNECTOR_EXAMPLES.fr}) ; aucun autre nom, adjectif ou verbe.\n` +
      '- Chaque mot doit ajouter au sens du nom : pas de mot juste pour couvrir une branche ou pour accoler une qualité (« … avec Clarté »).\n' +
      (perBranch === 1
        ? '- Au plus UN mot par branche [Qui]/[Quoi]/[Comment]/[Pourquoi] dans un même nom.\n'
        : `- Au plus ${perBranch} mots de la même branche dans un même nom.\n`) +
      (chunks
        ? `- L’acronyme prend le début de chaque mot porteur : une lettre ou plusieurs (INTERPOL = INTERnational POLice, ACROMOT = ACROnymes de MOTs-clés). ` +
          `Pour au moins la moitié des noms, prends plusieurs lettres de certains mots. L’acronyme compte de ${min} à ${max} lettres.\n`
        : `- L’acronyme est formé des initiales des mots porteurs : utilises-en donc de ${min} à ${max}.\n`) +
      'Pour chaque nom, donne fullName, les identifiants de ses mots porteurs dans l’ordre où ils apparaissent (ids), et l’acronyme (acronym).\n' +
      'Format : {"names": [{"fullName": "...", "ids": ["w3", "w1"], "acronym": "..."}]}',
    nameTask: (line) =>
      'Écris le nom complet de cet acronyme : un vrai nom en français correct, qui se lit comme le nom officiel ' +
      'd’une organisation ou d’un produit, jamais une liste de mots-clés ni une énumération.\n' +
      'Exemples :\n' +
      '- RATP : R=Régie · A=Autonomie · T=Transport · P=Paris → « Régie Autonome des Transports Parisiens »\n' +
      '- CLEF : C=Culture · L=Lecture · E=Échange · F=Famille → « Culture de la Lecture et de l’Échange Familial » ' +
      '(et non « Culture, Lecture, Échange et Famille »)\n' +
      'Méthode : le premier mot est le nom principal ; chaque mot suivant devient un complément introduit par de, des, pour, à, ' +
      'ou un adjectif accordé (Famille → Familial, Autonomie → Autonome).\n' +
      'Règles strictes : chaque mot imposé une fois, dans l’ordre des lettres ; tu peux changer sa forme en gardant sa racine, son sens ' +
      'et sa ou ses premières lettres (Initiales → Initiale convient ; Initiales → Initiative non, le sens change) ; ' +
      `entre eux, seulement des mots de liaison, qui ne portent jamais de lettre (${CONNECTOR_EXAMPLES.fr}) ; ` +
      'aucun autre nom, adjectif ou verbe.\n\n' +
      `Acronyme : ${line}\n` +
      'Propose 3 noms différents, le meilleur d’abord. Si aucun nom correct n’est possible, renvoie une liste vide.\n' +
      'Format : {"names": ["...", "...", "..."]}',
    rankTask:
      'Évalue chaque acronyme candidat ci-dessous pour ce projet. Seul compte le nom complet : est-il logique, ' +
      'et dit-il ce qu’est ou ce que fait ce projet ? Les lettres elles-mêmes peuvent être n’importe quoi. ' +
      'Mets "keep": false pour les noms qui n’ont pas de sens ou ne décrivent pas ce projet, et pour les noms vulgaires ou offensants. ' +
      'Pour chaque candidat gardé : un score de 0 à 100 (à quel point le nom complet décrit le projet, clairement et correctement), ' +
      'une justification (20 mots max) et un slogan court (12 mots max), en français. Pour un candidat rejeté, donne seulement id et keep.\n' +
      'Format : {"results": [{"id": "a1", "keep": true, "score": 80, "rationale": "...", "tagline": "..."}]}',
    titleTask: (max) =>
      `Propose un titre de travail pour ce projet : ${max} mots maximum, en français, qui dit clairement ce qu’il est et ce qu’il fait. ` +
      'Un titre naturel, ni acronyme ni liste de mots-clés. Majuscule au premier mot seulement (sauf noms propres), ' +
      'sans guillemets ni ponctuation finale.\n' +
      'Format : {"title": "..."}',
    branchNames: { who: 'Qui', what: 'Quoi', how: 'Comment', why: 'Pourquoi' },
  },
  en: {
    system:
      'You are a naming expert helping find an acronym for a project. You answer only with valid JSON, in English.',
    context: 'Project context',
    empty: '(no answer)',
    branchTask: (branch, q, a, existing) =>
      `Branch to expand: "${q}"\nAnswer: "${a}"\n` +
      (existing.length ? `Words already present (do not repeat): ${existing.join(', ')}\n` : '') +
      '\nGive 8 to 12 English words for this branch, drawn from this answer: first the key nouns and adjectives the answer itself uses ' +
      '(the things, actions, people and qualities it names), then plain synonyms of them. ' +
      'Stay concrete and literal: each word should make a reader think of this specific project, not of any project. ' +
      'Turn phrases into single nouns or adjectives (e.g. "wears people down" → Fatigue, "keeping ideas private" → Privacy); ' +
      'never copy a whole phrase. Avoid vague, generic words that could describe any brand or project, ' +
      'and leave out what the project rejects or replaces. ' +
      'Single words or very short noun phrases (2 words max). ' +
      (branch === 'who'
        ? 'Include 3 or 4 category nouns that fit this project, saying what it is and able to anchor its name (e.g. for an app: App, Platform, Tool). '
        : branch === 'why'
          ? 'For this branch, name the result and benefits the project brings, not the problems it fixes: those would make names say the opposite of the project. '
          : '') +
      'No articles or connecting words, no duplicates, capitalize each word.\n' +
      'Format: {"words": ["...", "..."]}',
    wordTask: (q, seed, existing) =>
      `Branch: "${q}"\nSeed word: "${seed}"\n` +
      (existing.length ? `Words already present (do not repeat): ${existing.join(', ')}\n` : '') +
      `\nGive 6 to 8 English words close to "${seed}", in the sense it has in this project's answers: ` +
      'plain synonyms, or the concrete things it refers to here. Stay concrete: each word should make a reader think of this specific project. ' +
      'Avoid vague, generic words that could describe any brand or project. ' +
      'Nouns or adjectives, single words or 2-word phrases max, no articles or connecting words, capitalized.\n' +
      'Format: {"words": ["...", "..."]}',
    composeTask: (min, max, perBranch, chunks) =>
      'Using the words above (ids w1, w2, …), write 12 different full names for this project. ' +
      'Each one is a correct, logical English phrase that says what the project is or does, ' +
      'the way "Federal Bureau of Investigation" says what the FBI is: a reader should understand the project from the name alone.\n' +
      'Rules:\n' +
      '- Start from a head noun (often a [Who] word) and link the other words as adjectives or as complements ' +
      'introduced by of, for, on…; never a list of keywords or an enumeration.\n' +
      '- Use only words from the list, each at most once; you may change a word\'s form (Keywords → Keyword) ' +
      'keeping its root, its meaning and its first letter.\n' +
      `- Between them, add only connecting words, which never carry a letter (${CONNECTOR_EXAMPLES.en}); no other noun, adjective or verb.\n` +
      '- Every word must add to what the name says: no word just to cover a branch or to tack on a quality ("… with Clarity").\n' +
      (perBranch === 1
        ? '- At most ONE word from each branch [Who]/[What]/[How]/[Why] in the same name.\n'
        : `- At most ${perBranch} words from the same branch in the same name.\n`) +
      (chunks
        ? `- The acronym takes the start of each letter-carrying word: one letter or several (INTERPOL = INTERnational POLice, ACROKEY = ACROnyms from KEYwords). ` +
          `For at least half of the names, take several letters from some words. The acronym has ${min} to ${max} letters.\n`
        : `- The acronym is the initials of the letter-carrying words, so use ${min} to ${max} of them.\n`) +
      'For each name give fullName, the ids of its letter-carrying words in the order they appear (ids), and the acronym.\n' +
      'Format: {"names": [{"fullName": "...", "ids": ["w3", "w1"], "acronym": "..."}]}',
    nameTask: (line) =>
      'Write the full name of this acronym: a real, grammatical English name that reads like the official name ' +
      'of an organization or product, never a list of keywords or an enumeration.\n' +
      'Examples:\n' +
      '- FBI: F=Federation · B=Bureau · I=Investigate → "Federal Bureau of Investigation"\n' +
      '- CARE: C=Culture · A=Art · R=Reading · E=Exchange → "Culture of Artistic Reading and Exchange" ' +
      '(not "Culture, Art, Reading and Exchange")\n' +
      'Method: pick the head noun (often the first or last word); every other word becomes a complement introduced by ' +
      'of, for, on, or an adjective (Federation → Federal, Art → Artistic).\n' +
      'Strict rules: each given word once, in letter order; you may change its form keeping its root, its meaning and first letter(s) ' +
      '(Initials → Initial is fine; Initials → Initiative is not, the meaning changes); ' +
      `between them, only connecting words, which never carry a letter (${CONNECTOR_EXAMPLES.en}); no other noun, adjective or verb.\n\n` +
      `Acronym: ${line}\n` +
      'Give 3 different names, best first. If no correct name is possible, return an empty list.\n' +
      'Format: {"names": ["...", "...", "..."]}',
    rankTask:
      'Rate each candidate acronym below for this project. Only the full name matters: does it make logical sense, ' +
      'and does it say what this project is or does? The letters themselves can be anything. ' +
      'Set "keep": false for names that make no sense or don\'t describe this project, and for vulgar or offensive ones. ' +
      'For each kept candidate: a score 0–100 (how clearly and correctly the full name describes the project), ' +
      'a rationale (≤ 20 words) and a short tagline (≤ 12 words), in English. For a rejected candidate, give only id and keep.\n' +
      'Format: {"results": [{"id": "a1", "keep": true, "score": 80, "rationale": "...", "tagline": "..."}]}',
    titleTask: (max) =>
      `Suggest a working title for this project: at most ${max} words, in English, saying clearly what it is and does. ` +
      'A natural title, not an acronym or a keyword list. Title Case, no quotes, no trailing punctuation.\n' +
      'Format: {"title": "..."}',
    branchNames: { who: 'Who', what: 'What', how: 'How', why: 'Why' },
  },
};

const lang = (l) => (T[l] ? l : 'fr');

function contextBlock(language, answers = {}) {
  const t = T[lang(language)];
  const q = QUESTIONS[lang(language)];
  const lines = BRANCHES.map((b) => `- ${q[b]} ${(answers[b] || '').trim() || t.empty}`);
  return `${t.context} :\n${lines.join('\n')}`;
}

function branchExpansion({ language, branch, answers, existing = [] }) {
  const l = lang(language);
  return {
    system: T[l].system,
    user: `${contextBlock(l, answers)}\n\n${T[l].branchTask(branch, QUESTIONS[l][branch], answers[branch] || '', existing)}`,
    temperature: 0.8,
  };
}

function wordExpansion({ language, branch, seed, answers, existing = [] }) {
  const l = lang(language);
  return {
    system: T[l].system,
    user: `${contextBlock(l, answers)}\n\n${T[l].wordTask(QUESTIONS[l][branch], seed, existing)}`,
    temperature: 0.8,
  };
}

// The LLM writes full names from the selected words; the code then checks them (compose.js).
// idWords: [{ id: 'w1', branch, text }]
function composeNames({ language, answers, idWords, minLength, maxLength, maxPerBranch = 1, allowChunks = false }) {
  const l = lang(language);
  const groups = BRANCHES.map((b) => {
    const list = idWords.filter((w) => w.branch === b).map((w) => `${w.id}: ${w.text}`);
    return list.length ? `[${T[l].branchNames[b]}]\n${list.join('\n')}` : '';
  }).filter(Boolean);
  return {
    system: T[l].system,
    user: `${contextBlock(l, answers)}\n\n${groups.join('\n\n')}\n\n${T[l].composeTask(minLength, maxLength, maxPerBranch, allowChunks)}`,
    temperature: 0.9,
  };
}

// One candidate per request: a small model writes real names when it handles one acronym at a time,
// and falls back to enumerations when given a list. candidate: { letters, parts: [{ text, letters }] }.
function nameAcronym({ language, answers, candidate }) {
  const l = lang(language);
  const sep = l === 'fr' ? ' : ' : ': ';
  const line = `${candidate.letters}${sep}${candidate.parts.map((p) => `${p.letters}=${p.text}`).join(' · ')}`;
  return {
    system: T[l].system,
    user: `${contextBlock(l, answers)}\n\n${T[l].nameTask(line)}`,
    temperature: 0.6,
  };
}

// Judge named candidates; candidate i is listed as id a{i+1}. candidates: [{ letters, parts: [{ lead, form }] }]
function rankAcronyms({ language, answers, candidates }) {
  const l = lang(language);
  const sep = l === 'fr' ? ' : ' : ': ';
  const lines = candidates.map((c, i) => `a${i + 1} ${c.letters}${sep}${phraseText(c.parts)}`);
  return {
    system: T[l].system,
    user: `${contextBlock(l, answers)}\n\n${T[l].rankTask}\n\n${lines.join('\n')}`,
    temperature: 0.3,
  };
}

// Short working title from the four answers, suggested alongside Generate words.
function projectTitle({ language, answers, maxWords }) {
  const l = lang(language);
  return {
    system: T[l].system,
    user: `${contextBlock(l, answers)}\n\n${T[l].titleTask(maxWords)}`,
    temperature: 0.7,
  };
}

module.exports = { BRANCHES, QUESTIONS, CONNECTOR_EXAMPLES, branchExpansion, wordExpansion, composeNames, nameAcronym, rankAcronyms, projectTitle };
