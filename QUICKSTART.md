# دليل البدء السريع - Orca Render Server GUI

## التثبيت والتشغيل في 3 خطوات 🚀

### 1. تثبيت الحزم
```bash
cd C:\Orca-Render-Pr\Server
npm install
```

إذا واجهت خطأ، قم بتثبيت socket.io يدوياً:
```bash
npm install socket.io
```

### 2. تشغيل الخادم
```bash
npm start
```

أو للتطوير مع إعادة التشغيل التلقائي:
```bash
npm run dev
```

### 3. فتح الواجهة
افتح المتصفح على:
```
http://localhost:6068
```

---

## ماذا تتوقع؟ 👀

### عند تشغيل الخادم
ستظهر رسائل في terminal:
```
[Server] Render V2 server listening on port 6068
[Server] Dashboard available at: http://localhost:6068
[Server] This server will save incoming JSON jobs and watch for .mp4 outputs.
[Watcher] Setting up new file watcher for directory: ...
```

### عند فتح الواجهة
ستشاهد:
- ✅ حالة الاتصال: **متصل** (أخضر)
- 📊 4 بطاقات إحصائيات في الأعلى
- 📋 قائمة الوظائف (فارغة في البداية)
- 📝 سجل الأحداث بالأسفل

---

## اختبار سريع 🧪

### إرسال وظيفة تجريبية

استخدم Postman أو curl:

```bash
curl -X POST http://localhost:6068/render \
  -H "Content-Type: application/json" \
  -d '{
    "episodeId": "test123",
    "episodeCode": "TEST01",
    "podcastCode": "BH",
    "reels": [
      {
        "id": "reel1",
        "reelName": "BH-TEST01-Reel1.mp4"
      }
    ]
  }'
```

في Windows PowerShell:
```powershell
$body = @{
    episodeId = "test123"
    episodeCode = "TEST01"
    podcastCode = "BH"
    reels = @(
        @{
            id = "reel1"
            reelName = "BH-TEST01-Reel1.mp4"
        }
    )
} | ConvertTo-Json

Invoke-RestMethod -Uri "http://localhost:6068/render" -Method POST -Body $body -ContentType "application/json"
```

### ماذا سيحدث؟
1. ✅ سيظهر في terminal: `[API /render] Received new render job for episode TEST01`
2. 🌐 في الواجهة: ستظهر الوظيفة الجديدة في قائمة الانتظار
3. 📝 سجل الأحداث: رسالة "وظيفة جديدة مضافة: TEST01"

---

## استكشاف المشاكل الشائعة ⚠️

### المشكلة: `Cannot find module 'socket.io'`
**الحل**:
```bash
npm install socket.io
```

### المشكلة: `Port 6068 already in use`
**الحل**: أوقف العملية القديمة أو غيّر المنفذ في [server.js:18](server.js#L18)

### المشكلة: الواجهة لا تظهر
**الحل**: تأكد من:
1. الخادم يعمل (انظر terminal)
2. الرابط صحيح: `http://localhost:6068`
3. لا يوجد خطأ في console المتصفح (F12)

### المشكلة: `Error: Could not load the default credentials`
**السبب**: ملف GCS credentials غير موجود أو خاطئ

**الحل**: تأكد من وجود الملف:
```
C:\Orca-Render-Pr\Server\config\valiant-monitor-459014-p0-282c36407221.json
```

---

## الخطوات التالية 📚

بعد تشغيل الخادم بنجاح:

1. **اقرأ [README.md](README.md)** للتفاصيل الكاملة
2. **تكامل Premiere Pro**: تأكد من تشغيل امتداد Orca في Premiere Pro
3. **اختبار السير الكامل**: أرسل وظيفة حقيقية وانتظر ملفات MP4

---

## التواصل والدعم 💬

- 📖 الوثائق الكاملة: [README.md](README.md)
- 🐛 مشاكل تقنية: تحقق من سجل الأحداث في الواجهة
- 📊 مراقبة الأداء: استخدم endpoint `/status`

---

**استمتع باستخدام Orca Render Server! 🎬**
