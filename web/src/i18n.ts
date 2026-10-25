// Patient-facing text in San Francisco's most common languages. Nurses always see English.
export type Lang = 'en' | 'es' | 'zh' | 'vi' | 'tl';

export const LANGS: Array<{ code: Lang; label: string }> = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Español' },
  { code: 'zh', label: '中文' },
  { code: 'vi', label: 'Tiếng Việt' },
  { code: 'tl', label: 'Tagalog' },
];

const T = {
  tagline: {
    en: 'Check in to the ER before you arrive.',
    es: 'Regístrese en la sala de emergencias antes de llegar.',
    zh: '到达前先在急诊室登记。',
    vi: 'Đăng ký phòng cấp cứu trước khi bạn đến.',
    tl: 'Mag-check in sa ER bago ka dumating.',
  },
  name: { en: 'Name', es: 'Nombre', zh: '姓名', vi: 'Họ tên', tl: 'Pangalan' },
  age: { en: 'Age', es: 'Edad', zh: '年龄', vi: 'Tuổi', tl: 'Edad' },
  minutesAway: { en: 'Minutes away', es: 'Minutos de distancia', zh: '还有几分钟到', vi: 'Còn bao nhiêu phút', tl: 'Ilang minuto pa' },
  describe: {
    en: 'Tap and describe your symptoms',
    es: 'Toque y describa sus síntomas',
    zh: '点击并描述您的症状',
    vi: 'Nhấn và mô tả triệu chứng của bạn',
    tl: 'Pindutin at ilarawan ang iyong nararamdaman',
  },
  tapDone: { en: 'Tap when done', es: 'Toque al terminar', zh: '说完请点击', vi: 'Nhấn khi xong', tl: 'Pindutin kapag tapos na' },
  working: { en: 'Working...', es: 'Procesando...', zh: '处理中...', vi: 'Đang xử lý...', tl: 'Pinoproseso...' },
  heard: { en: 'What we heard', es: 'Lo que escuchamos', zh: '我们听到的内容', vi: 'Những gì chúng tôi nghe được', tl: 'Ang narinig namin' },
  typeHere: {
    en: 'Or type your symptoms here',
    es: 'O escriba sus síntomas aquí',
    zh: '或在这里输入您的症状',
    vi: 'Hoặc nhập triệu chứng ở đây',
    tl: 'O i-type dito ang iyong nararamdaman',
  },
  checkIn: { en: 'Check in', es: 'Registrarme', zh: '登记', vi: 'Đăng ký', tl: 'Mag-check in' },
  call911: {
    en: 'If this is life-threatening, call 911.',
    es: 'Si su vida corre peligro, llame al 911.',
    zh: '如有生命危险，请拨打911。',
    vi: 'Nếu nguy hiểm đến tính mạng, hãy gọi 911.',
    tl: 'Kung nanganganib ang buhay, tumawag sa 911.',
  },
  checkedIn: { en: "You're checked in", es: 'Ya está registrado', zh: '您已登记', vi: 'Bạn đã đăng ký', tl: 'Naka-check in ka na' },
  arrived: { en: "I've arrived", es: 'Ya llegué', zh: '我已到达', vi: 'Tôi đã đến', tl: 'Nakarating na ako' },
  checkOnMe: { en: 'Check on me now', es: 'Revisarme ahora', zh: '查看我的情况', vi: 'Kiểm tra tôi ngay', tl: 'Tingnan ako ngayon' },
  listening: {
    en: 'Listening... tap when done',
    es: 'Escuchando... toque al terminar',
    zh: '正在听...说完请点击',
    vi: 'Đang nghe... nhấn khi xong',
    tl: 'Nakikinig... pindutin kapag tapos na',
  },
  shareFamily: {
    en: 'Share my status with family',
    es: 'Compartir mi estado con mi familia',
    zh: '与家人分享我的状态',
    vi: 'Chia sẻ tình trạng với gia đình',
    tl: 'Ibahagi ang aking kalagayan sa pamilya',
  },
  linkCopied: {
    en: 'Link copied. Send it to someone you trust.',
    es: 'Enlace copiado. Envíelo a alguien de confianza.',
    zh: '链接已复制。请发给您信任的人。',
    vi: 'Đã sao chép liên kết. Hãy gửi cho người bạn tin tưởng.',
    tl: 'Nakopya ang link. Ipadala sa taong pinagkakatiwalaan mo.',
  },
  feelWorse: {
    en: 'If you feel much worse, tell the front desk right away or call 911.',
    es: 'Si se siente mucho peor, avise de inmediato en recepción o llame al 911.',
    zh: '如果您感觉更糟，请立即告诉前台或拨打911。',
    vi: 'Nếu bạn thấy tệ hơn nhiều, hãy báo ngay quầy lễ tân hoặc gọi 911.',
    tl: 'Kung lumala ang pakiramdam mo, sabihan agad ang front desk o tumawag sa 911.',
  },
  youSaid: { en: 'You said', es: 'Usted dijo', zh: '您说', vi: 'Bạn đã nói', tl: 'Sinabi mo' },
  autoCheckins: {
    en: 'Automatic check-ins',
    es: 'Revisiones automáticas',
    zh: '自动询问',
    vi: 'Tự động hỏi thăm',
    tl: 'Awtomatikong pagtingin',
  },
  nextIn: { en: 'next in', es: 'próxima en', zh: '下次', vi: 'lần tới sau', tl: 'susunod sa' },
} satisfies Record<string, Record<Lang, string>>;

export function t(key: keyof typeof T, lang: Lang): string {
  return T[key][lang] ?? T[key].en;
}
