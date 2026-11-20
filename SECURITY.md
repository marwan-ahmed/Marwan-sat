# سياسة الأمان — Marwan SAT

## الإبلاغ عن ثغرة في SAT نفسه
**لا تفتح issue عامة.** استخدم الإبلاغ الخاص من تبويب **Security ← Report a vulnerability** في المستودع على GitHub.

> لصاحب المستودع: فعّل خيار *Private vulnerability reporting* من إعدادات المستودع حتى يظهر هذا الزر.

اذكر في البلاغ: الإصدار، والخطوات، والأثر، ومثالاً قابلاً لإعادة الإنتاج إن أمكن.

## ما يُعدّ ثغرة في SAT
- تجاوز `guard` لكتابة ملف تمنعه المرحلة الحالية عبر أداة كتابة.
- تجاوز `verify` بحيث يمر تعديل على الاختبارات المجمّدة، أو تغيير خارج `allowed_write`، أو تعديل ملف مُدار، دون أن يُكشف.
- تمرير تقرير عُدّلت أقسامه المولّدة دون أن تكشفه `phase`.
- أي سلوك في أدوات SAT ينفّذ تعليمات من محتوى المستودع أو مخرجات الأدوات.

## ما ليس ثغرة (حدود موثقة في الميثاق §10)
- كتابة ملف بأمر طرفية دون المرور بـ`guard`: هذا حد معروف، والضمان الأخير هو `verify` وCI.
- البوابتان 0 و1 في وضع `gates.approval: agent` إجرائيتان بالتصميم.

## الإصدارات المدعومة
يُصلح آخر إصدار فقط خلال المرحلة التجريبية (`0.x`).

---

### English
Do not open public issues for vulnerabilities. Use **Security → Report a vulnerability** (private reporting). In scope: bypassing `guard` through a write tool, bypassing `verify` integrity checks, passing a tampered report, any tool following instructions found in repository content. Out of scope: writes through shell commands (documented limitation; `verify` and CI are the last line), procedural gates in `agent` approval mode.
