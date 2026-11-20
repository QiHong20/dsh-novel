// 纯文本与字数：只做计算，不碰文件。

/** 章节字数：去掉所有空白后按字符计（中文场景比按词计更贴近直觉）。 */
export function countChars(text) {
  return Array.from(String(text ?? '').replace(/\s+/gu, '')).length
}

/**
 * 章纲级「占位正文」：`（待写）重生在 1998 年…` 这种一句话梗概不是正文。
 * 它让「已写 N 章」和进度条虚高，也让改状态时把这一章错标成 draft。
 */
export function isPlaceholderText(text) {
  const body = String(text ?? '').replace(/\s+/gu, '')
  if (body === '') return false
  if (!/^[（(【\[]*(待写|待补|待续|占位|TODO|todo|TBD)/u.test(body)) return false
  return Array.from(body).length <= 300
}

export const INTERIOR_RE = /(心里|心头|心中|暗自|心底|脑子里|觉得|想着|想起|后悔|不甘|发狠|喉咙|喉结|嗓子|咽了口|咽下|胸口|手心|掌心|指尖|手指|后背|耳朵|耳根|太阳穴|胃里|鼻头|眼眶|发烫|发凉|发紧|冷汗|愣|松了口气|咬牙|手抖|腿软|呼吸|心跳|空了一块)/u

export const MONEY_RE = /(到账|入账|赚|挣|收钱|给钱|递过去|推过去|掏出|数出|三百|五百|一千|两千|合同|提成|分红|工资|净利|存折|涨|签字)/u

export const AI_TONE_PHRASES = [
  [/在[^。！？\n]{2,14}的(?:背景|时代|大环境|形势|浪潮)下/u, '空转开头「在…的背景下」'],
  [/值得一提的(?:是|还有)/u, '「值得一提的是」'],
  [/不仅[^。！？\n]{2,24}(?:而且|更是|还)/u, '机械递进「不仅…而且…」'],
  [/(?:无疑|毫无疑问)(?:是|地)/u, '判词「无疑是」'],
  [/(?:在一定程度|某种意义)上/u, '退让「在某种程度上」'],
  [/(?:注入|赋能|赋予)[^。！？\n]{0,8}(?:活力|动能|动力|生机)/u, '官腔「注入活力」'],
  [/(?:全方位|多维度|立体化|系统性地)/u, '「全方位 / 多维度」'],
  [/(?:映入眼帘|尽收眼底|扑面而来)/u, '「映入眼帘 / 扑面而来」'],
  [/(?:不禁|不由得)(?:让人|令人|使人)/u, '「不禁让人…」'],
  [/(?:彰显|折射出|折射着|昭示)/u, '「彰显 / 折射出」'],
  [/(?:总之|综上所述|总而言之)/u, '总结式收尾'],
  [/(?:仿佛|似乎)(?:在|是)(?:诉说|倾述|讲述|低语)/u, '「仿佛在诉说」'],
]

export const DIALOGUE_REVIEW_RULES = [
  '对白场景钩子：先定位这句话所在的现场，再判断说法。',
  '逐段区分实际对白、内心、引用和无法确定；实际对白逐轮核对谁对谁说、想让对方知道或做什么、对方已知什么、时间压力与手上动作，以及人物关系和说话习惯。没有明确依据时先补读，不补造人物动机。',
  '检查表达能否当场被听懂：省略的对象、指代和后果是否清楚，是否为了狠话、金句或陌生搭配而让听者解码；正常省略、行话和人物特有表达可保留。先保留说话目的，再选择贴合现场的说法。',
  '危机中检查解释是否有必要和时间，不一律缩成喊话；平静交涉允许完整表达、试探和绕弯。不把身份差异改成统一的日常口语，也不改变威胁程度、承诺、事实和事件结果。',
  '复核的 paragraphs 中，带对话标签的段落填写 dialogue.kind；实际对白填写 speaker、listener、intent、pressure、assessment。多轮对白逐轮说明，同段混有实际对白与内心或引用时按实际对白审查；纯内心或引用在 reason 中解释分类依据。发现问题或无法确定时先如实登记 conflict/uncertain；修改后重新获取审稿包。',
].join('\n')

export const DEAI_RULES = [
  '写作与语义审稿纪律：',
  '1. 保留事实、情节、人物意图、数字、设定和有效信息；不补造因果、动机、动作，不把可能改成确定。台词可调整表达，不能改变其信息、承诺和人物关系。',
  '2. 先读完整场景、人物卡和文风锚点，再判断具体问题。机械命中只作线索；正常重复、纠正、对比和长句可以保留，不以零命中为目标。',
  '3. 对话按角色的身份、目的、认知和口癖区分；不把所有人统一改成短句、粗口、反问或抢话。禁止把人物卡口癖当台词原句打卡复读（口癖只是语气参考），也禁止全员统一成极简电报体对白——该啰嗦、绕弯、插科打诨或带生活毛边的角色要写出松弛感、语气词与停顿。仅当时间压力和人物状态需要时压缩解释。',
  '4. 核对场景时间：倒计时、动作、观察、回忆和交涉是否相容；删减或调整拖慢现场的说明，不擅自修改倒计时数值或事件结果。',
  '5. 检查细节是否反复证明同一标签、旁白是否重复解释已演出的意义、句段是否固定为动作—体感—总结、冲突是否只为剧情服务。保留有信息或声口价值的细节，不机械删修辞。',
  '6. 优先级：事实原意 > 作者文风与角色声口 > 场景自然度 > 原句式。只修有问题的地方；对照原稿核实信息保留，并说明保留与修改的理由。',
  DIALOGUE_REVIEW_RULES,
  '场景与篇幅：先核对人物设备的相对位置、移动通路、工具来源、状态变化、安全约束和动作因果，再审表达；不以脑补步骤补救矛盾。空间过渡、动作前提和关键后果必须写清。目标字数只供参考，超出不删减、不缩写、不提前收尾；按情节决定分章，上下文预算不限制正文长度。紧张时按当前理解需要投放设定，不用格言总结或逐项感官报幕替代情节；技术与身体反应要有既有设定依据。',
].join('\n')

export function styleStats(text) {
  const source = String(text ?? '').replace(/\r\n/gu, '\n')
  const chars = countChars(source)
  const sentences = source
    .split(/[。！？!?…]+/u)
    .map(item => item.replace(/\s+/gu, ''))
    .filter(Boolean)
  const paragraphs = source
    .split(/\n+/u)
    .map(item => item.trim())
    .filter(Boolean)
  const dialogue = paragraphs.filter(item => /[「『“"＂]/u.test(item)).length
  const per1000 = mark => Math.round(((source.split(mark).length - 1) / Math.max(chars, 1)) * 10000) / 10
  const average = list => (list.length ? Math.round((list.reduce((sum, item) => sum + item.length, 0) / list.length) * 10) / 10 : 0)

  const counts = new Map()
  for (const chunk of source.replace(/[^\u4e00-\u9fff]+/gu, ' ').split(/\s+/u)) {
    for (let index = 0; index + 1 < chunk.length; index += 1) {
      const gram = chunk.slice(index, index + 2)
      if (CJK_STOP.has(gram[0]) || CJK_STOP.has(gram[1])) continue
      counts.set(gram, (counts.get(gram) ?? 0) + 1)
    }
  }



  return {
    chars,
    sentences: sentences.length,
    paragraphs: paragraphs.length,
    avgSentence: average(sentences),
    avgParagraph: average(paragraphs),
    dialogueRatio: paragraphs.length ? Math.round((dialogue / paragraphs.length) * 100) : 0,
    per1000: {
      comma: per1000('，'),
      period: per1000('。'),
      ellipsis: per1000('…'),
      dash: per1000('—'),
      semicolon: per1000('；'),
      exclaim: per1000('！'),
      question: per1000('？'),
    },
    words: [...counts.entries()]
      .filter(([, count]) => count >= 3)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 16)
      .map(([word, count]) => ({ word, count })),
  }
}

export function styleFit(text, cardText, refText) {
  const refSource = refText && countChars(refText) > 3000 ? refText : styleAnchorText(cardText)
  const ref = styleStats(refSource)
  const act = styleStats(text)
  const rows = []
  // hard=false 的指标只记录、不报警。段均/对话段/逗号测的是排版与习惯，
  // 读者读着顺就是顺；把它们当硬指标会把「段落比样本长一点」也判成跑偏。
  const push = (key, label, refValue, actValue, tol, hard = true) => {
    if (!refValue) return
    const ratio = Math.round((actValue / refValue) * 100) / 100
    const low = tol ? tol[0] : 0.65
    const high = tol ? tol[1] : 1.55
    rows.push({ key, label, ref: refValue, act: actValue, ratio, hard, flag: hard && (ratio < low || ratio > high) })
  }
  push('avgSentence', '句均字数', ref.avgSentence, act.avgSentence, [0.7, 1.45])
  push('avgParagraph', '段均字数', ref.avgParagraph, act.avgParagraph, [0.7, 1.4], false)
  push('dialogue', '含对话段占比', ref.dialogueRatio, act.dialogueRatio, [0.5, 2], false)
  push('comma', '每千字逗号', ref.per1000.comma, act.per1000.comma, [0.6, 1.7], false)
  push('period', '每千字句号', ref.per1000.period, act.per1000.period, [0.7, 1.5])
  // 标点类指标：参考文本里本来就只出现几次的，比值没意义，先要求样本里够多。
  if (ref.per1000.dash >= 1.5 && act.per1000.dash >= 1)
    push('dash', '每千字破折号', ref.per1000.dash, act.per1000.dash, [0.35, 2.8], false)
  if (ref.per1000.ellipsis >= 1.5 && act.per1000.ellipsis >= 1)
    push('ellipsis', '每千字省略号', ref.per1000.ellipsis, act.per1000.ellipsis, [0.35, 2.8], false)
  const flagged = rows.filter(row => row.flag)
  return { ok: flagged.length === 0, rows, flagged, ref, act }
}

export function interiorStats(text) {
  const paras = String(text ?? '')
    .split(/\n+/)
    .map(item => item.trim())
    .filter(item => item && !/^[「『"“][^」』"”]+[」』"”]$/u.test(item))
  const hit = paras.filter(item => INTERIOR_RE.test(item)).length
  return { paras: paras.length, hit, ratio: paras.length ? Math.round((hit / paras.length) * 1000) / 10 : 0 }
}

export function payoffMoments(text) {
  const paras = String(text ?? '').split(/\n+/).map(item => item.trim()).filter(Boolean)
  const samples = []
  let total = 0
  let hit = 0
  for (let i = 0; i < paras.length; i += 1) {
    if (!MONEY_RE.test(paras[i])) continue
    total += 1
    const window = paras.slice(i, Math.min(paras.length, i + 3))
    if (window.some(item => INTERIOR_RE.test(item))) {
      hit += 1
      continue
    }
    if (samples.length < 3) samples.push(paras[i].slice(0, 30))
  }
  return { total, hit, samples }
}

export function detectAiTone(text) {
  const body = String(text ?? '')
  const signals = []
  const add = (kind, label, samples, count = samples?.length ?? 0) => {
    if (!samples || samples.length === 0) return
    signals.push({ kind, label, count, samples: samples.slice(0, 3) })
  }
  if (!body.trim()) return { signals, total: 0 }

  for (const [pattern, label] of AI_TONE_PHRASES) {
    const hits = []
    for (const match of body.matchAll(new RegExp(pattern.source, 'gu'))) {
      hits.push(aiSnippet(body, match.index ?? 0, match[0].length))
    }
    add('cliche', label, hits)
  }

  const paragraphs = body.split(/\n+/u).map(item => item.trim()).filter(item => item.length > 0)
  const connectors = paragraphs.filter(item => /^(然而|因此|此外|同时|总之|首先|其次|再者|另外|与此)/u.test(item))
  if (paragraphs.length >= 4 && connectors.length / paragraphs.length >= 0.3) {
    add('connector-start', `有 ${connectors.length}/${paragraphs.length} 段以「然而 / 因此 / 同时」开头`, connectors.map(item => item.slice(0, 24)))
  }
  const paragraphLengths = paragraphs.map(item => countChars(item)).filter(item => item > 0)
  if (paragraphLengths.length >= 5) {
    const mean = paragraphLengths.reduce((sum, item) => sum + item, 0) / paragraphLengths.length
    const variance = paragraphLengths.reduce((sum, item) => sum + (item - mean) ** 2, 0) / paragraphLengths.length
    const deviation = mean > 0 ? Math.sqrt(variance) / mean : 0
    if (deviation < 0.12) {
      add('uniform-paragraph', `段落长度几乎一样（平均 ${Math.round(mean)} 字，波动只有 ${(deviation * 100).toFixed(0)}%）`, paragraphs.slice(0, 2).map(item => item.slice(0, 22)), 1)
    }
  }

  const sentences = aiSentences(body)
  if (sentences.length >= 20) {
    const shorts = sentences.filter(item => countChars(item) <= 8)
    if (shorts.length / sentences.length < 0.05) {
      add('no-short', `${sentences.length} 句里只有 ${shorts.length} 句短句（≤8 字），请结合文风检查节奏，不要求强行插入短句`, sentences.filter(item => countChars(item) > 8).slice(0, 2), 1)
    }
    const groups = []
    let bucket = [sentences[0]]
    for (let index = 1; index < sentences.length; index += 1) {
      const previous = bucket[bucket.length - 1]
      const current = sentences[index]
      const sameShift = current[0] === bucket[0][0] && Math.abs(countChars(current) - countChars(previous)) <= 2
      if (sameShift) bucket.push(current)
      else {
        groups.push(bucket)
        bucket = [current]
      }
    }
    groups.push(bucket)
    const parallels = groups.filter(group => group.length >= 3 && countChars(group[0]) >= 10)
    if (parallels.length > 0) {
      add('parallel-run', `有 ${parallels.length} 处连续三句以上字数齐平、开头相同`, parallels.slice(0, 3).map(group => group.slice(0, 3).join('｜')), parallels.length)
    }
  }

  const quotes = [...body.matchAll(/[「『"“]([^」』"”]{2,})[」』"”]/gu)].map(match => match[1].trim())
  if (quotes.length >= 5) {
    const clean = quotes.filter(item => !/[，,]|…|—/u.test(item) && countChars(item) > 12)
    if (clean.length / quotes.length >= 0.7) {
      add('clean-dialogue', `有 ${clean.length}/${quotes.length} 句较长且缺少停顿标点，需结合语境判断是否生硬`, clean.slice(0, 2), clean.length)
    }
    if (quotes.length >= 8 && !quotes.some(quote => /[—…]/u.test(quote))) {
      add('no-pause', '对话中缺少显式停顿标点，请结合角色和场景判断是否自然，不要求补破折号或省略号', quotes.slice(0, 2), 1)
    }
  }

  // 相邻对话同句头复读（如「现在断，…」「现在断，…」）
  const echoHits = []
  let prevQuoteHead = ''
  let prevQuoteFull = ''
  for (const qm of body.matchAll(/[「『"“]([^」』"”\n]{2,})[」』"”]/gu)) {
    const head = qm[1].replace(/[^\u4e00-\u9fff]/gu, '').slice(0, 3)
    if (head.length >= 2 && head === prevQuoteHead) {
      echoHits.push(`${prevQuoteFull.slice(0, 18)} ∥ ${qm[1].slice(0, 18)}`)
    }
    prevQuoteHead = head
    prevQuoteFull = qm[1]
  }
  add('echo-dialogue', '连续引语同句头，需区分机械接龙与正常重复、确认或反驳', echoHits)

  // 对称格言 / 镜像对比收尾（如「…看不出来。…看得出来。」「…先…，…再…」「不是…，是…」）
  const symmetryHits = []
  const SYMMETRY_PATTERNS = [
    /([^。！？\n]{2,12})(?:看不出来|听不见|说不清|抓不住|管不了)。\s*[^。！？\n]{1,8}(?:看得出来|听得见|说得清|抓得住|管得了)/gu,
    /[^。！？\n]{2,12}听得见，[^。！？\n]{2,12}听不见/gu,
    /手上先[^，。！？\n]{1,8}，嘴上再[^，。！？\n]{1,8}/gu,
    /不是[^，。！？\n]{2,12}，是[^。！？\n]{2,12}(?:[。！？]|$)/gu,
  ]
  for (const pat of SYMMETRY_PATTERNS) {
    for (const m of body.matchAll(pat)) {
      symmetryHits.push(aiSnippet(body, m.index ?? 0, m[0].length))
    }
  }
  add('symmetry-aphorism', '对称句式，需结合语境区分空泛总结与有效对比', symmetryHits)

  const total = signals.reduce((sum, item) => sum + item.count, 0)
  return { signals, total }
}

export const CJK_STOP = new Set('的了着过是在有和与就都也还很太不没我你他她它们这那哪个上下来的地去得把被给对从到又再才只'.split(''))

export function styleAnchorText(cardText) {
  const sections = String(cardText ?? '').split(/\n##\s+/u).slice(1)
  for (const chunk of sections) {
    const rows = chunk.split(/\r?\n/u)
    if (!/^锚点原文/u.test(rows[0].trim())) continue
    return rows.slice(1).filter(line => !/^###[ \t]+/u.test(line)).map(line => line.replace(/^>[ \t]?/u, '')).join('\n')
  }
  return ''
}

export const aiSnippet = (body, index, length) => {
  const from = Math.max(0, index - 12)
  const to = Math.min(body.length, index + length + 12)
  return `${from > 0 ? '…' : ''}${body.slice(from, to).replace(/\s+/gu, ' ')}${to < body.length ? '…' : ''}`
}

export const aiSentences = body => body.split(/[。！？!?…]/u).map(item => item.trim()).filter(item => item.length > 0)

/** 把章数规格里的阿拉伯数字或中文数字转为整数。 */
export function numberFromToken(token) {
  const raw = String(token ?? '').trim()
  if (!raw) return 0
  if (/^\d+$/u.test(raw)) return Number(raw)
  const digits = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
  if (raw === '十') return 10
  const tenAt = raw.indexOf('十')
  if (tenAt === -1) return digits[raw] ?? 0
  const head = tenAt === 0 ? 1 : digits[raw.slice(0, tenAt)] ?? 0
  const tail = raw.slice(tenAt + 1)
  return head * 10 + (tail ? digits[tail] ?? 0 : 0)
}
