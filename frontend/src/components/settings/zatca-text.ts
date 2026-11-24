// FactorPOS: text for the ZATCA settings card. It is shown only to Saudi shops, so it
// carries English and Arabic itself instead of adding keys to all 32 FloCafe locales;
// every other language sees English.

export const ZATCA_TEXT_EN = {
  title: 'ZATCA e-invoicing (Phase 2)',
  description:
    'Seller details, onboarding this till with ZATCA, and signed simplified tax invoices.',
  loading: 'Loading ZATCA settings…',
  genericError: 'Something went wrong. Please try again.',
  sellerTitle: 'Seller details on invoices',
  sellerName: 'Seller name',
  vatNumber: 'VAT number',
  sellerNameHint: 'The seller name and VAT number come from the Store and Tax settings.',
  fields: {
    crn: 'Commercial registration (CR) number',
    street: 'Street',
    building_number: 'Building number (4 digits)',
    district: 'District',
    city: 'City',
    postal_code: 'Postal code (5 digits)',
    branch_name: 'Branch name',
    industry: 'Business category',
  },
  saveSeller: 'Save seller details',
  sellerSaved: 'Seller details saved',
  onboardingTitle: 'Onboard this till (simulation)',
  onboardingDescription:
    "Get this till's ZATCA certificate. Generate an OTP on the FATOORA simulation portal, enter it here, and FactorPOS does the rest.",
  stepCompliance: 'Certificate request sent, compliance certificate received',
  stepChecks: 'Sample invoice, credit note and debit note checked by ZATCA',
  stepCertificate: 'Signing certificate received',
  documents: {
    invoice: 'Simplified invoice',
    credit_note: 'Credit note',
    debit_note: 'Debit note',
  },
  passed: 'passed',
  failed: 'failed',
  certificateExpires: 'Certificate expires',
  tillId: 'Till ID (EGS)',
  lastError: 'Last error from ZATCA',
  otp: 'OTP',
  otpHint:
    'The OTP is valid for about one hour. If a later step fails, Retry continues without a new OTP.',
  onboard: 'Onboard',
  resume: 'Retry',
  renew: 'Renew certificate',
  onboardingDone: 'This till is onboarded with ZATCA',
  issuingTitle: 'Issue ZATCA invoices',
  issuingOffDescription: 'Off: bills are not recorded as ZATCA invoices.',
  issuingOnDescription:
    'On (simulation): every paid bill and refund becomes a signed ZATCA invoice or credit note.',
  switchOn: 'Switch on (simulation)',
  switchOff: 'Switch off',
  issuingOn: 'ZATCA invoices are on (simulation)',
  issuingOff: 'ZATCA invoices are off',
  productionNote:
    'Production comes after automatic reporting to ZATCA is built and the pilot is signed off.',
  errors: {
    zatca_otp_required: 'Enter the OTP from the FATOORA portal.',
    zatca_otp_invalid: 'The OTP is 6 digits.',
    zatca_not_onboarded: 'Onboard this till with ZATCA before switching invoices on.',
    zatca_secure_storage_unavailable:
      "This computer's secure storage is unavailable, so ZATCA keys cannot be kept.",
    zatca_onboarding_busy: 'Onboarding is already running. Please wait.',
  },
  warningsOne: '1 warning',
  warningsMany: '{count} warnings',
} as const;

type Shape<T> = { [K in keyof T]: T[K] extends string ? string : Shape<T[K]> };

export const ZATCA_TEXT_AR: Shape<typeof ZATCA_TEXT_EN> = {
  title: 'الفوترة الإلكترونية - زاتكا (المرحلة الثانية)',
  description: 'بيانات البائع، وربط نقطة البيع هذه مع زاتكا، وفواتير ضريبية مبسطة موقّعة.',
  loading: 'جارٍ تحميل إعدادات زاتكا…',
  genericError: 'حدث خطأ. يرجى المحاولة مرة أخرى.',
  sellerTitle: 'بيانات البائع في الفواتير',
  sellerName: 'اسم البائع',
  vatNumber: 'الرقم الضريبي',
  sellerNameHint: 'اسم البائع والرقم الضريبي من إعدادات المتجر والضريبة.',
  fields: {
    crn: 'رقم السجل التجاري',
    street: 'الشارع',
    building_number: 'رقم المبنى (4 أرقام)',
    district: 'الحي',
    city: 'المدينة',
    postal_code: 'الرمز البريدي (5 أرقام)',
    branch_name: 'اسم الفرع',
    industry: 'نشاط المنشأة',
  },
  saveSeller: 'حفظ بيانات البائع',
  sellerSaved: 'تم حفظ بيانات البائع',
  onboardingTitle: 'ربط نقطة البيع هذه (بيئة المحاكاة)',
  onboardingDescription:
    'احصل على شهادة زاتكا لنقطة البيع هذه. أنشئ رمز التحقق (OTP) في بوابة فاتورة للمحاكاة، وأدخله هنا، وسيتولى FactorPOS الباقي.',
  stepCompliance: 'تم إرسال طلب الشهادة واستلام شهادة الامتثال',
  stepChecks: 'فحصت زاتكا فاتورة وإشعار دائن وإشعار مدين تجريبية',
  stepCertificate: 'تم استلام شهادة التوقيع',
  documents: {
    invoice: 'فاتورة مبسطة',
    credit_note: 'إشعار دائن',
    debit_note: 'إشعار مدين',
  },
  passed: 'ناجح',
  failed: 'فشل',
  certificateExpires: 'تنتهي الشهادة في',
  tillId: 'معرّف نقطة البيع (EGS)',
  lastError: 'آخر خطأ من زاتكا',
  otp: 'رمز التحقق (OTP)',
  otpHint:
    'رمز التحقق صالح لمدة ساعة تقريبًا. إذا فشلت خطوة لاحقة، يكمل زر إعادة المحاولة دون رمز جديد.',
  onboard: 'ربط',
  resume: 'إعادة المحاولة',
  renew: 'تجديد الشهادة',
  onboardingDone: 'تم ربط نقطة البيع هذه مع زاتكا',
  issuingTitle: 'إصدار فواتير زاتكا',
  issuingOffDescription: 'متوقف: لا تُسجّل الفواتير كفواتير زاتكا.',
  issuingOnDescription:
    'مفعّل (محاكاة): كل فاتورة مدفوعة واسترداد تصبح فاتورة أو إشعار دائن موقّعًا لدى زاتكا.',
  switchOn: 'تفعيل (محاكاة)',
  switchOff: 'إيقاف',
  issuingOn: 'فواتير زاتكا مفعّلة (محاكاة)',
  issuingOff: 'فواتير زاتكا متوقفة',
  productionNote: 'بيئة الإنتاج تأتي بعد بناء الإبلاغ التلقائي إلى زاتكا واعتماد التجربة.',
  errors: {
    zatca_otp_required: 'أدخل رمز التحقق من بوابة فاتورة.',
    zatca_otp_invalid: 'رمز التحقق مكوّن من 6 أرقام.',
    zatca_not_onboarded: 'اربط نقطة البيع هذه مع زاتكا قبل تفعيل الفواتير.',
    zatca_secure_storage_unavailable:
      'التخزين الآمن غير متاح على هذا الجهاز، لذلك لا يمكن حفظ مفاتيح زاتكا.',
    zatca_onboarding_busy: 'عملية الربط جارية بالفعل. يرجى الانتظار.',
  },
  warningsOne: 'تحذير واحد',
  warningsMany: '{count} تحذيرات',
};
