# Orca Render Server - Windows Service Setup

## التثبيت

### 1. تثبيت node-windows
```bash
npm install node-windows --save
```

### 2. تثبيت الخدمة
**مهم: يجب تشغيل الأمر كمسؤول (Administrator)**

```bash
# افتح PowerShell أو CMD كمسؤول
cd C:\Orca-Render-Pr\Server
node install-service.js
```

### 3. التحقق من التثبيت
```bash
# عرض الخدمة في قائمة الخدمات
services.msc
# ابحث عن "Orca Render Server"
```

---

## إدارة الخدمة

### من سطر الأوامر (CMD كمسؤول):

```bash
# تشغيل الخدمة
net start "Orca Render Server"

# إيقاف الخدمة
net stop "Orca Render Server"

# إعادة تشغيل الخدمة
net stop "Orca Render Server" && net start "Orca Render Server"

# التحقق من حالة الخدمة
sc query "Orca Render Server"
```

### من PowerShell (كمسؤول):

```powershell
# تشغيل
Start-Service "Orca Render Server"

# إيقاف
Stop-Service "Orca Render Server"

# إعادة تشغيل
Restart-Service "Orca Render Server"

# عرض الحالة
Get-Service "Orca Render Server"
```

### من واجهة Windows Services:

1. اضغط `Win + R`
2. اكتب `services.msc` واضغط Enter
3. ابحث عن "Orca Render Server"
4. انقر بزر الماوس الأيمن للتحكم (Start/Stop/Restart)

---

## إلغاء التثبيت

```bash
# في CMD أو PowerShell كمسؤول
cd C:\Orca-Render-Pr\Server
node uninstall-service.js
```

---

## السجلات (Logs)

السجلات موجودة في:
```
C:\Orca-Render-Pr\Server\daemon\
```

للوصول للسجلات:
```bash
# عرض آخر 50 سطر من السجل
Get-Content C:\Orca-Render-Pr\Server\daemon\*.log -Tail 50

# مراقبة السجل مباشرة
Get-Content C:\Orca-Render-Pr\Server\daemon\*.log -Wait
```

---

## استكشاف الأخطاء

### الخدمة لا تبدأ:
1. تحقق من السجلات في مجلد `daemon`
2. تأكد من وجود `node.exe` في PATH
3. تحقق من صلاحيات المجلد
4. تأكد من عدم وجود خدمة أخرى على المنفذ 6068

### تحديث الخدمة بعد تعديل الكود:
```bash
# إعادة تشغيل الخدمة
net stop "Orca Render Server"
net start "Orca Render Server"
```

### التحقق من المنفذ:
```bash
# التحقق من أن المنفذ 6068 مفتوح
netstat -ano | findstr :6068
```

---

## معلومات الخدمة

- **الاسم**: Orca Render Server
- **المنفذ**: 6068
- **نوع البدء**: Automatic (تلقائي مع النظام)
- **الوصف**: Handles video rendering jobs and uploads to Google Cloud Storage
