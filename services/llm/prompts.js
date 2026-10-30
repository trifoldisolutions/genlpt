// All LLM prompt builders. System prompts are written in the session language, except Haitian Creole's:
// models follow instructions in English more reliably, so those are in English and ask for Creole.
const { phraseText } = require('../acronym/phrase');

const BRANCHES = ['who', 'what', 'how', 'why'];

// Connectors shown to the model; each must be in normalize.CONNECTORS (checked by tests).
const CONNECTOR_EXAMPLES = {
  fr: 'de, des, du, d’, la, le, les, l’, au, aux, à, en, et, ou, pour, par, sur, sous, avec, sans',
  en: 'of, and, for, the, in, on, to, with, by, at',
  es: 'de, del, la, el, los, las, al, a, en, y, o, para, por, con, sin, sobre',
  ht: 'pou, nan, ak, avèk, sou, an, la, a, de, yon, e, oswa',
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
  es: {
    who: '¿Quién o qué es?',
    what: '¿Qué hace?',
    how: '¿Cómo funciona?',
    why: '¿Por qué existe? ¿Qué problema resuelve?',
  },
  ht: {
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
    composeTask: (min, max, perBranch, chunks, fresh) =>
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
      (fresh.length
        ? `- Les mots ${fresh.join(', ')} viennent d’être ajoutés : utilise au moins l’un d’eux dans au moins la moitié des noms, ` +
          'tant que le nom reste correct et logique.\n'
        : '') +
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
    reformulateSystem:
      'Tu aides à décrire clairement un projet, pour qu’un outil de naming y trouve des mots et un acronyme. Tu réponds uniquement en JSON valide.',
    // What each question is for, so the rewrite answers it
    reformulateFocus: {
      who: 'ce qu’est le projet (application, service, association…) et pour qui',
      what: 'ce qu’il fait : ses actions principales et ce qu’on en retire',
      how: 'comment il fonctionne : ses étapes, ses moyens ou sa méthode',
      why: 'pourquoi il existe : le problème qu’il résout et ce qu’il apporte',
    },
    reformulateTask: ({ q, focus, answer, title, lo, hi }) =>
      (title ? `Titre de travail : « ${title} »\n` : '') +
      'Ces réponses décrivent un même projet. Leurs mots deviennent la matière de son nom : ' +
      'chaque réponse doit donc dire clairement ce qu’est le projet, sous l’angle de sa question.\n\n' +
      `Question à retravailler : « ${q} » (${focus})\nRéponse actuelle : « ${answer} »\n\n` +
      'D’abord, résume en une phrase l’idée du projet tirée de toutes les réponses : ce qu’il est, pour qui, et ce qu’il change.\n' +
      'Puis réécris la réponse à cette question à la lumière de cette idée : exprime ce que l’auteur veut dire, pas seulement ce qu’il a écrit.\n' +
      '- Garde ses faits et son point de vue (je, nous, il…) ; ne contredis aucune réponse et n’ajoute rien qu’elles ne disent pas.\n' +
      '- Reste sur ce que demande cette question ; inutile de répéter ce qu’une autre réponse dit déjà.\n' +
      '- Des mots simples et concrets : nomme les choses, personnes, actions et qualités. ' +
      'Pas de slogan ni de mots vagues qui iraient à n’importe quel projet.\n' +
      `- Un seul paragraphe, sans liste ni guillemets, dans la langue de la réponse, de ${lo} à ${hi} caractères ; ` +
      'plus court si les réponses n’en disent pas assez, plutôt qu’inventer.\n' +
      'Format : {"idea": "...", "answer": "..."}',
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
    composeTask: (min, max, perBranch, chunks, fresh) =>
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
      (fresh.length
        ? `- Words ${fresh.join(', ')} were just added: use at least one of them in at least half of the names, ` +
          'as long as the name stays correct and logical.\n'
        : '') +
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
    reformulateSystem:
      'You help people describe their project clearly, so a naming tool can find words and an acronym in it. You answer only with valid JSON.',
    reformulateFocus: {
      who: 'what kind of thing the project is (an app, a service, a group…) and who it is for',
      what: 'what it does: its main actions and what people get from it',
      how: 'how it works: its steps, means or method',
      why: 'why it exists: the problem it solves and what it brings',
    },
    reformulateTask: ({ q, focus, answer, title, lo, hi }) =>
      (title ? `Working title: "${title}"\n` : '') +
      'These answers describe one project. Their words become the material for its name, ' +
      'so each answer should say plainly what the project is, from its own question’s angle.\n\n' +
      `Question to rework: "${q}" (${focus})\nCurrent answer: "${answer}"\n\n` +
      'First, sum up the project’s idea in one sentence, from all the answers: what it is, who it is for, and what it changes.\n' +
      'Then rewrite the answer to this question in light of that idea: say what the author means, not only what they wrote.\n' +
      '- Keep its facts and point of view (I, we, it…); contradict no answer and add nothing they don’t say.\n' +
      '- Stick to what this question asks; what another answer already says doesn’t need repeating.\n' +
      '- Plain, concrete words: name the things, people, actions and qualities. ' +
      'No slogans, and no vague words that could fit any project.\n' +
      `- One paragraph, no lists or quotes, in the answer’s language, ${lo} to ${hi} characters; ` +
      'shorter if the answers don’t say enough, rather than inventing.\n' +
      'Format: {"idea": "...", "answer": "..."}',
    branchNames: { who: 'Who', what: 'What', how: 'How', why: 'Why' },
  },
  es: {
    system:
      'Eres un experto en naming que ayuda a encontrar un acrónimo para un proyecto. Respondes únicamente con JSON válido, en español.',
    context: 'Contexto del proyecto',
    empty: '(sin respuesta)',
    branchTask: (branch, q, a, existing) =>
      `Rama a desarrollar: «${q}»\nRespuesta: «${a}»\n` +
      (existing.length ? `Palabras ya presentes (no repetir): ${existing.join(', ')}\n` : '') +
      '\nDa de 8 a 12 palabras en español para esta rama, sacadas de esta respuesta: primero los sustantivos y adjetivos clave que usa la propia respuesta ' +
      '(las cosas, acciones, personas y cualidades que nombra), luego sinónimos sencillos de esas palabras. ' +
      'Sé concreto y literal: cada palabra debe hacer pensar en este proyecto en particular, no en cualquier proyecto. ' +
      'Convierte las expresiones en un solo sustantivo o adjetivo (p. ej. «desanima» → Cansancio, «mantener las ideas en privado» → Privacidad); ' +
      'nunca copies una frase entera. Evita las palabras vagas y genéricas que podrían describir cualquier marca o cualquier proyecto, ' +
      'y deja de lado lo que el proyecto rechaza o sustituye. ' +
      'Palabras sueltas o expresiones nominales muy cortas (2 palabras como máximo). ' +
      (branch === 'who'
        ? 'Incluye 3 o 4 sustantivos de categoría adecuados a este proyecto, que digan lo que es y puedan encabezar su nombre (p. ej. para una aplicación: Aplicación, Plataforma, Herramienta). '
        : branch === 'why'
          ? 'En esta rama, nombra el resultado y los beneficios que aporta el proyecto, no los problemas que resuelve: si no, los nombres dirían lo contrario del proyecto. '
          : '') +
      'Sin artículos ni palabras de enlace, sin duplicados, cada palabra empieza con mayúscula.\n' +
      'Formato: {"words": ["...", "..."]}',
    wordTask: (q, seed, existing) =>
      `Rama: «${q}»\nPalabra de partida: «${seed}»\n` +
      (existing.length ? `Palabras ya presentes (no repetir): ${existing.join(', ')}\n` : '') +
      `\nDa de 6 a 8 palabras en español cercanas a «${seed}», en el sentido que tiene en las respuestas de este proyecto: ` +
      'sinónimos sencillos, o las cosas concretas a las que se refiere aquí. Sé concreto: cada palabra debe hacer pensar en este proyecto en particular. ' +
      'Evita las palabras vagas y genéricas que podrían describir cualquier marca o cualquier proyecto. ' +
      'Sustantivos o adjetivos, palabras sueltas o expresiones de 2 palabras como máximo, sin artículos ni palabras de enlace, con mayúscula.\n' +
      'Formato: {"words": ["...", "..."]}',
    composeTask: (min, max, perBranch, chunks, fresh) =>
      'A partir de las palabras de arriba (identificadores w1, w2, …), escribe 12 nombres completos distintos para este proyecto. ' +
      'Cada uno es una frase nominal en español correcta y lógica que dice lo que es o lo que hace el proyecto, ' +
      'como «Organización Nacional de Ciegos Españoles» dice lo que es la ONCE: se debe entender el proyecto leyendo solo el nombre.\n' +
      'Reglas:\n' +
      '- Parte de un sustantivo principal (a menudo una palabra [Quién]) y enlaza las demás palabras como adjetivos concordados o complementos ' +
      'introducidos por de, para, en…; nunca una lista de palabras clave ni una enumeración.\n' +
      '- Usa solo palabras de la lista, cada una una vez como máximo; puedes cambiar su forma (Iniciales → Inicial) ' +
      'conservando su raíz, su sentido y su primera letra.\n' +
      `- Entre ellas, añade solo palabras de enlace, que nunca aportan letra (${CONNECTOR_EXAMPLES.es}); ningún otro sustantivo, adjetivo o verbo.\n` +
      '- Cada palabra debe añadir sentido al nombre: ninguna palabra solo para cubrir una rama o para añadir una cualidad («… con Claridad»).\n' +
      (perBranch === 1
        ? '- Como máximo UNA palabra de cada rama [Quién]/[Qué]/[Cómo]/[Por qué] en un mismo nombre.\n'
        : `- Como máximo ${perBranch} palabras de la misma rama en un mismo nombre.\n`) +
      (chunks
        ? `- El acrónimo toma el comienzo de cada palabra que aporta letras: una letra o varias (MERCOSUR = MERcado COmún del SUR, ACROPAL = ACRÓnimos de PALabras clave). ` +
          `En al menos la mitad de los nombres, toma varias letras de algunas palabras. El acrónimo tiene de ${min} a ${max} letras.\n`
        : `- El acrónimo se forma con las iniciales de las palabras que aportan letras: usa por tanto de ${min} a ${max}.\n`) +
      (fresh.length
        ? `- Las palabras ${fresh.join(', ')} se acaban de añadir: usa al menos una de ellas en al menos la mitad de los nombres, ` +
          'siempre que el nombre siga siendo correcto y lógico.\n'
        : '') +
      'Para cada nombre, da fullName, los identificadores de sus palabras que aportan letras en el orden en que aparecen (ids), y el acrónimo (acronym).\n' +
      'Formato: {"names": [{"fullName": "...", "ids": ["w3", "w1"], "acronym": "..."}]}',
    nameTask: (line) =>
      'Escribe el nombre completo de este acrónimo: un nombre real en español correcto, que se lea como el nombre oficial ' +
      'de una organización o de un producto, nunca una lista de palabras clave ni una enumeración.\n' +
      'Ejemplos:\n' +
      '- ONCE: O=Organización · N=Nación · C=Ciego · E=España → «Organización Nacional de Ciegos Españoles»\n' +
      '- CLIF: C=Cultura · L=Lectura · I=Intercambio · F=Familia → «Cultura de la Lectura y del Intercambio Familiar» ' +
      '(y no «Cultura, Lectura, Intercambio y Familia»)\n' +
      'Método: la primera palabra es el sustantivo principal; cada palabra siguiente se convierte en un complemento introducido por de, para, en, ' +
      'o en un adjetivo concordado (Familia → Familiar, Nación → Nacional).\n' +
      'Reglas estrictas: cada palabra dada una vez, en el orden de las letras; puedes cambiar su forma conservando su raíz, su sentido ' +
      'y su primera o primeras letras (Iniciales → Inicial vale; Iniciales → Iniciativa no, el sentido cambia); ' +
      `entre ellas, solo palabras de enlace, que nunca aportan letra (${CONNECTOR_EXAMPLES.es}); ` +
      'ningún otro sustantivo, adjetivo o verbo.\n\n' +
      `Acrónimo: ${line}\n` +
      'Propón 3 nombres distintos, el mejor primero. Si no es posible ningún nombre correcto, devuelve una lista vacía.\n' +
      'Formato: {"names": ["...", "...", "..."]}',
    rankTask:
      'Evalúa cada acrónimo candidato de abajo para este proyecto. Solo cuenta el nombre completo: ¿es lógico, ' +
      'y dice lo que es o lo que hace este proyecto? Las letras en sí pueden ser cualquier cosa. ' +
      'Pon "keep": false para los nombres que no tienen sentido o no describen este proyecto, y para los nombres vulgares u ofensivos. ' +
      'Para cada candidato conservado: una puntuación de 0 a 100 (hasta qué punto el nombre completo describe el proyecto, con claridad y corrección), ' +
      'una justificación (20 palabras como máximo) y un eslogan corto (12 palabras como máximo), en español. Para un candidato rechazado, da solo id y keep.\n' +
      'Formato: {"results": [{"id": "a1", "keep": true, "score": 80, "rationale": "...", "tagline": "..."}]}',
    titleTask: (max) =>
      `Propón un título de trabajo para este proyecto: ${max} palabras como máximo, en español, que diga claramente lo que es y lo que hace. ` +
      'Un título natural, ni acrónimo ni lista de palabras clave. Mayúscula solo en la primera palabra (salvo nombres propios), ' +
      'sin comillas ni puntuación final.\n' +
      'Formato: {"title": "..."}',
    reformulateSystem:
      'Ayudas a describir claramente un proyecto, para que una herramienta de naming encuentre en él palabras y un acrónimo. Respondes únicamente con JSON válido.',
    reformulateFocus: {
      who: 'qué es el proyecto (una aplicación, un servicio, una asociación…) y para quién',
      what: 'lo que hace: sus acciones principales y lo que la gente obtiene de él',
      how: 'cómo funciona: sus pasos, sus medios o su método',
      why: 'por qué existe: el problema que resuelve y lo que aporta',
    },
    reformulateTask: ({ q, focus, answer, title, lo, hi }) =>
      (title ? `Título de trabajo: «${title}»\n` : '') +
      'Estas respuestas describen un mismo proyecto. Sus palabras se convierten en la materia de su nombre: ' +
      'cada respuesta debe decir claramente lo que es el proyecto, desde el ángulo de su pregunta.\n\n' +
      `Pregunta a reelaborar: «${q}» (${focus})\nRespuesta actual: «${answer}»\n\n` +
      'Primero, resume en una frase la idea del proyecto a partir de todas las respuestas: qué es, para quién, y qué cambia.\n' +
      'Luego reescribe la respuesta a esta pregunta a la luz de esa idea: expresa lo que el autor quiere decir, no solo lo que escribió.\n' +
      '- Conserva sus hechos y su punto de vista (yo, nosotros, él…); no contradigas ninguna respuesta ni añadas nada que no digan.\n' +
      '- Cíñete a lo que pide esta pregunta; no hace falta repetir lo que ya dice otra respuesta.\n' +
      '- Palabras sencillas y concretas: nombra las cosas, personas, acciones y cualidades. ' +
      'Nada de eslóganes ni de palabras vagas que valdrían para cualquier proyecto.\n' +
      `- Un solo párrafo, sin listas ni comillas, en el idioma de la respuesta, de ${lo} a ${hi} caracteres; ` +
      'más corto si las respuestas no dicen lo suficiente, en lugar de inventar.\n' +
      'Formato: {"idea": "...", "answer": "..."}',
    branchNames: { who: 'Quién', what: 'Qué', how: 'Cómo', why: 'Por qué' },
  },
};

// Haitian Creole: English instructions (see the top) with Creole examples, asking for Creole. The rest
// (context labels, the answer rewrite, which keeps the answer's own language) is English's.
T.ht = {
  ...T.en,
  system:
    'You are a naming expert helping find an acronym for a project. You answer only with valid JSON, in Haitian Creole ' +
    '(Kreyòl ayisyen) with its standard spelling (lekòl, pwogram, aplikasyon), never in French.',
  branchTask: (branch, q, a, existing) =>
    `Branch to expand: "${q}"\nAnswer: "${a}"\n` +
    (existing.length ? `Words already present (do not repeat): ${existing.join(', ')}\n` : '') +
    '\nGive 8 to 12 Haitian Creole words for this branch, drawn from this answer: first the key nouns and adjectives the answer itself uses ' +
    '(the things, actions, people and qualities it names), then plain synonyms of them. ' +
    'Stay concrete and literal: each word should make a reader think of this specific project, not of any project. ' +
    'Turn phrases into single nouns or adjectives (e.g. "dekouraje moun" → Fatig, "kenbe lide yo prive" → Konfidansyalite); ' +
    'never copy a whole phrase. Avoid vague, generic words that could describe any brand or project, ' +
    'and leave out what the project rejects or replaces. ' +
    'Single words or very short noun phrases (2 words max). ' +
    (branch === 'who'
      ? 'Include 3 or 4 category nouns that fit this project, saying what it is and able to anchor its name (e.g. for an app: Aplikasyon, Platfòm, Zouti). '
      : branch === 'why'
        ? 'For this branch, name the result and benefits the project brings, not the problems it fixes: those would make names say the opposite of the project. '
        : '') +
    'No articles (la, nan, yo…) or connecting words, no duplicates, capitalize each word.\n' +
    'Format: {"words": ["...", "..."]}',
  wordTask: (q, seed, existing) =>
    `Branch: "${q}"\nSeed word: "${seed}"\n` +
    (existing.length ? `Words already present (do not repeat): ${existing.join(', ')}\n` : '') +
    `\nGive 6 to 8 Haitian Creole words close to "${seed}", in the sense it has in this project's answers: ` +
    'plain synonyms, or the concrete things it refers to here. Stay concrete: each word should make a reader think of this specific project. ' +
    'Avoid vague, generic words that could describe any brand or project. ' +
    'Nouns or adjectives, single words or 2-word phrases max, no articles or connecting words, capitalized.\n' +
    'Format: {"words": ["...", "..."]}',
  composeTask: (min, max, perBranch, chunks, fresh) =>
    'Using the words above (ids w1, w2, …), write 12 different full names for this project. ' +
    'Each one is a correct, logical Haitian Creole phrase that says what the project is or does, ' +
    'the way "Akademi Kreyòl Ayisyen" says what the AKA is: a reader should understand the project from the name alone.\n' +
    'Rules:\n' +
    '- Start from a head noun (often a [Who] word) and link the other words to it: as adjectives, as a possessor placed right after ' +
    'its noun with no linking word (Lekòl Timoun = a school for children), or as complements introduced by pou, nan, sou…; ' +
    'never a list of keywords or an enumeration.\n' +
    '- Use only words from the list, each at most once; you may change a word\'s form (Nasyon → Nasyonal) ' +
    'keeping its root, its meaning and its first letter.\n' +
    `- Between them, add only connecting words, which never carry a letter (${CONNECTOR_EXAMPLES.ht}); no other noun, adjective or verb.\n` +
    '- Every word must add to what the name says: no word just to cover a branch or to tack on a quality ("… ak Klète").\n' +
    (perBranch === 1
      ? '- At most ONE word from each branch [Who]/[What]/[How]/[Why] in the same name.\n'
      : `- At most ${perBranch} words from the same branch in the same name.\n`) +
    (chunks
      ? '- The acronym takes the start of each letter-carrying word: one letter or several (INTERPOL = INTERnational POLice). ' +
        `For at least half of the names, take several letters from some words. The acronym has ${min} to ${max} letters.\n`
      : `- The acronym is the initials of the letter-carrying words, so use ${min} to ${max} of them.\n`) +
    (fresh.length
      ? `- Words ${fresh.join(', ')} were just added: use at least one of them in at least half of the names, ` +
        'as long as the name stays correct and logical.\n'
      : '') +
    'For each name give fullName, the ids of its letter-carrying words in the order they appear (ids), and the acronym.\n' +
    'Format: {"names": [{"fullName": "...", "ids": ["w3", "w1"], "acronym": "..."}]}',
  nameTask: (line) =>
    'Write the full name of this acronym: a real, grammatical Haitian Creole name that reads like the official name ' +
    'of an organization or product, never a list of keywords or an enumeration.\n' +
    'Examples:\n' +
    '- AKA: A=Akademi · K=Kreyòl · A=Ayiti → "Akademi Kreyòl Ayisyen"\n' +
    '- KLEF: K=Kilti · L=Lekti · E=Echanj · F=Fanmi → "Kilti Lekti ak Echanj nan Fanmi" ' +
    '(not "Kilti, Lekti, Echanj ak Fanmi")\n' +
    'Method: the first word is the head noun; every other word qualifies it, as a possessor right after its noun with no linking word ' +
    '(Kilti Lekti = a culture of reading), as a complement introduced by pou, nan, sou, or as an adjective (Ayiti → Ayisyen, Nasyon → Nasyonal).\n' +
    'Strict rules: each given word once, in letter order; you may change its form keeping its root, its meaning and first letter(s) ' +
    '(Nasyon → Nasyonal is fine; Inisyal → Inisyativ is not, the meaning changes); ' +
    `between them, only connecting words, which never carry a letter (${CONNECTOR_EXAMPLES.ht}); no other noun, adjective or verb.\n\n` +
    `Acronym: ${line}\n` +
    'Give 3 different names, best first. If no correct name is possible, return an empty list.\n' +
    'Format: {"names": ["...", "...", "..."]}',
  rankTask:
    'Rate each candidate acronym below for this project. Only the full name matters: does it make logical sense, ' +
    'and does it say what this project is or does? The letters themselves can be anything. ' +
    'Set "keep": false for names that make no sense or don\'t describe this project, for names in French rather than Haitian Creole, ' +
    'and for vulgar or offensive ones. ' +
    'For each kept candidate: a score 0–100 (how clearly and correctly the full name describes the project), ' +
    'a rationale (≤ 20 words) and a short tagline (≤ 12 words), in Haitian Creole. For a rejected candidate, give only id and keep.\n' +
    'Format: {"results": [{"id": "a1", "keep": true, "score": 80, "rationale": "...", "tagline": "..."}]}',
  titleTask: (max) =>
    `Suggest a working title for this project: at most ${max} words, in Haitian Creole, saying clearly what it is and does. ` +
    'A natural title, not an acronym or a keyword list. Capitalize the first word only (except proper nouns), ' +
    'no quotes, no trailing punctuation.\n' +
    'Format: {"title": "..."}',
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
    step: 'words',
  };
}

function wordExpansion({ language, branch, seed, answers, existing = [] }) {
  const l = lang(language);
  return {
    system: T[l].system,
    user: `${contextBlock(l, answers)}\n\n${T[l].wordTask(QUESTIONS[l][branch], seed, existing)}`,
    temperature: 0.8,
    step: 'expand',
  };
}

// The LLM writes full names from the selected words; the code then checks them (compose.js).
// idWords: [{ id: 'w1', branch, text, fresh }]; fresh words were added since the last run, and half the names should use one.
function composeNames({ language, answers, idWords, minLength, maxLength, maxPerBranch = 1, allowChunks = false }) {
  const l = lang(language);
  const groups = BRANCHES.map((b) => {
    const list = idWords.filter((w) => w.branch === b).map((w) => `${w.id}: ${w.text}`);
    return list.length ? `[${T[l].branchNames[b]}]\n${list.join('\n')}` : '';
  }).filter(Boolean);
  // Only worth asking while some words are old: when all are new, every name uses them anyway
  const fresh = idWords.filter((w) => w.fresh);
  const freshIds = fresh.length < idWords.length ? fresh.map((w) => w.id) : [];
  return {
    system: T[l].system,
    user: `${contextBlock(l, answers)}\n\n${groups.join('\n\n')}\n\n${T[l].composeTask(minLength, maxLength, maxPerBranch, allowChunks, freshIds)}`,
    temperature: 0.9,
    step: 'compose',
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
    step: 'name',
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
    step: 'rank',
  };
}

// Short working title from the four answers, suggested alongside Generate words.
function projectTitle({ language, answers, maxWords }) {
  const l = lang(language);
  return {
    system: T[l].system,
    user: `${contextBlock(l, answers)}\n\n${T[l].titleTask(maxWords)}`,
    temperature: 0.7,
    step: 'title',
  };
}

// An answer's "Reformulate with AI": the model sums up the project's idea from all the answers (and the title
// the user or AI gave it), then rewrites this one answer in light of it. The idea is asked first so the
// rewrite follows from it; only `answer` is used. Target length: comfortably past the minimum, below the cap.
function reformulateAnswer({ language, branch, answers, title = '', minChars, maxChars }) {
  const l = lang(language);
  const task = T[l].reformulateTask({
    q: QUESTIONS[l][branch],
    focus: T[l].reformulateFocus[branch],
    answer: (answers[branch] || '').trim(),
    title: title.trim(),
    lo: Math.round(minChars * 1.5),
    hi: Math.round(maxChars * 0.9),
  });
  return {
    system: T[l].reformulateSystem,
    user: `${contextBlock(l, answers)}\n\n${task}`,
    temperature: 0.5,
    step: 'reformulate',
  };
}

module.exports = { BRANCHES, QUESTIONS, CONNECTOR_EXAMPLES, branchExpansion, wordExpansion, composeNames, nameAcronym, rankAcronyms, projectTitle, reformulateAnswer };
