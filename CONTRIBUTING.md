# المساهمة في Marwan SAT

شكراً لاهتمامك. SAT أداة حوكمة، فمعيار القبول فيها أعلى من المعتاد: أي تغيير يجب أن يُبقي الضمانات قائمة أو يقوّيها.

## المبادئ التي لا تُكسر
1. **لا اعتماديات.** أدوات `core/bin` و`cli` تعمل بـNode.js وحده. لا `npm install` لأي حزمة.
2. **الميثاق هو المرجع.** أي تغيير في سلوك الأدوار أو المراحل أو البوابات يبدأ بتعديل `charter/CHARTER.md`، ويعتمده صاحب المستودع.
3. **لا شيء يخص مشروعاً بعينه** في المستودع: لا أسماء عملاء، ولا مسارات من مشروع حقيقي، ولا بيانات.
4. **كل سلوك جديد له اختبار** في `tests/`.

## التشغيل محلياً
```bash
npm test          # node --test — يحتاج git وNode.js 20+
```
تنشئ الاختبارات مستودعات git مؤقتة وتثبّت SAT فيها، ثم تمر بدورة مهمة كاملة.

## إضافة مكدس جديد
أنشئ `stacks/<stack>/` يحتوي:
- `preset.yaml`: قالب `project.yaml`، بالصيغة الجزئية من YAML (بلا `|` ولا `>` ولا anchors).
- `sensitive-paths.txt`
- `security-checklist.md`
- `skills/<stack>-conventions/SKILL.md`
- `ci-setup.yml` (اختياري)

ثم أضف المكدس إلى `STACKS` في `core/bin/lib/config.mjs`، وإلى `project.schema.json`، وإلى اختبار «presets render for every stack».

## Pull Requests
- فرع لكل تغيير، ووصف يذكر القسم المتأثر من الميثاق.
- لا دمج قبل نجاح CI ومراجعة صاحب المستودع.

---

### English
Zero dependencies, the charter is the source of truth, nothing project-specific, every behaviour change ships with a test. Run `npm test`. New stacks go under `stacks/<stack>/` (see the list above).
