export type SupportedLocale = "zh-CN" | "en-US";
export type LocalePreference = SupportedLocale;

export interface CommonDictionary {
  loading: string;
  refresh: string;
  save: string;
  saving: string;
  cancel: string;
  confirm: string;
  back: string;
  next: string;
  copy: string;
  copied: string;
  statusActive: string;
  statusSuspended: string;
  statusArchived: string;
  statusPending: string;
  unknownError: string;
  retry: string;
}

export interface SetupDictionary {
  eyebrow: (step: number, total: number) => string;
  step1Title: string;
  step1Description: string;
  step1NoticeTitle: string;
  step1NoticeBody: string;
  step1SectionTitle: string;
  step1SectionSubtitle: string;
  step1TokenLabel: string;
  step1TokenPlaceholder: string;
  step1Submit: string;
  step2Title: string;
  step2Description: string;
  step2SectionTitle: string;
  step2SectionSubtitle: string;
  step2NameLabel: string;
  step2NamePlaceholder: string;
  step2EmailLabel: string;
  step2EmailPlaceholder: string;
  step2PasswordLabel: string;
  step2PasswordHint: string;
  step2Submit: string;
  step3Title: string;
  step3Description: string;
  step3SectionTitle: string;
  step3SectionSubtitle: string;
  step3InstanceNameLabel: string;
  step3InstanceNamePlaceholder: string;
  step3InstanceSlugLabel: string;
  step3InstanceSlugHint: string;
  step3InstanceSlugPlaceholder: string;
  step3AdminApiUrlLabel: string;
  step3AdminApiUrlHint: string;
  step3AdminApiUrlPlaceholder: string;
  step3CustomerSiteUrlLabel: string;
  step3CustomerSiteUrlHint: string;
  step3CustomerSiteUrlPlaceholder: string;
  step3Submit: string;
}

export interface NavDictionary {
  groupOverview: string;
  groupCatalog: string;
  groupOperations: string;
  groupCommercial: string;
  groupServices: string;
  groupSettings: string;
  itemOverview: string;
  itemOverviewDesc: string;
  itemProducts: string;
  itemProductsDesc: string;
  itemLicensePlans: string;
  itemLicensePlansDesc: string;
  itemLicenses: string;
  itemLicensesDesc: string;
  itemCustomers: string;
  itemCustomersDesc: string;
  itemBilling: string;
  itemBillingDesc: string;
  itemEmailHub: string;
  itemEmailHubDesc: string;
  itemOps: string;
  itemOpsDesc: string;
  itemInstance: string;
  itemInstanceDesc: string;
  itemMembers: string;
  itemMembersDesc: string;
  itemProfile: string;
  itemProfileDesc: string;
  collapseNav: string;
  expandNav: string;
  closeNav: string;
  openNav: string;
}

export interface TopbarDictionary {
  consoleTitle: string;
  logout: string;
  viewLoadFailed: (title: string) => string;
  roles: {
    owner: string;
    admin: string;
    member: string;
    viewer: string;
  };
}

export interface SettingsDictionary {
  languageTitle: string;
  languageDescription: string;
  languageLabel: string;
  languageSaved: string;
  options: {
    zhCN: string;
    enUS: string;
  };
  profileEyebrow: string;
  profileTitle: string;
  profileDescription: string;
  basicInfoTitle: string;
  basicInfoSubtitle: string;
  nameLabel: string;
  emailLabel: string;
  emailHint: string;
  saveProfile: string;
  profileSaved: string;
  passwordTitle: string;
  passwordSubtitle: string;
  currentPasswordLabel: string;
  newPasswordLabel: string;
  newPasswordHint: string;
  changePassword: string;
  passwordChanged: string;
  instanceEyebrow: string;
  instanceTitle: string;
  instanceDescription: string;
  instanceSectionTitle: string;
  instanceNameLabel: string;
  instanceSlugLabel: string;
  adminApiUrlLabel: string;
  customerSiteUrlLabel: string;
  instanceStatusLabel: string;
  createdAtLabel: string;
  updatedAtLabel: string;
  networkNoticeTitle: string;
  networkNoticeBody: string;
}

export interface AuthDictionary {
  brandTagline: string;
  brandDescription: string;
  principleIsolation: string;
  principleCrypto: string;
  principleFulfillment: string;
  loginEyebrow: string;
  loginTitle: string;
  loginDescription: string;
  emailLabel: string;
  passwordLabel: string;
  loginSubmit: string;
  customerFootnote: string;
  connectingBrand: string;
  checkingSession: string;
  connectionFailedTitle: string;
  connectionFailedDescription: string;
  reconnectButton: string;
}

export interface LocaleDictionary {
  common: CommonDictionary;
  setup: SetupDictionary;
  nav: NavDictionary;
  topbar: TopbarDictionary;
  settings: SettingsDictionary;
  auth: AuthDictionary;
  errors: Record<string, string>;
}
