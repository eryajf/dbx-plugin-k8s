import { useTranslation } from 'react-i18next'
import { usePageTitle } from '@/hooks/use-page-title'
import { useAppearance } from '@/components/appearance-provider'
import { colorThemes, type ColorTheme } from '@/components/color-theme-provider'
import { SidebarCustomizer } from '@/components/sidebar-customizer'
import { LanguageToggle } from '@/components/language-toggle'
import { ModeToggle } from '@/components/mode-toggle'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'

export function SettingsPage() {
  const { t } = useTranslation()
  const { colorTheme, setColorTheme, font, setFont } = useAppearance()
  usePageTitle(t('settings.title', 'Settings'))
  return <div className="space-y-4">
    <h1 className="text-3xl">{t('settings.title', 'Settings')}</h1>
    <Card>
      <CardHeader><CardTitle>{t('settings.appearance', 'Appearance')}</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between"><span>{t('common.theme', 'Theme')}</span><ModeToggle /></div>
        <div className="flex items-center justify-between"><span>{t('common.language', 'Language')}</span><LanguageToggle /></div>
        <div className="flex items-center justify-between gap-4"><span>{t('settings.colorTheme', 'Color theme')}</span>
          <Select value={colorTheme} onValueChange={v=>setColorTheme(v as ColorTheme)}><SelectTrigger className="w-48"><SelectValue /></SelectTrigger><SelectContent>{Object.keys(colorThemes).map(v=><SelectItem key={v} value={v}>{t(`colorTheme.${v}`, v)}</SelectItem>)}</SelectContent></Select>
        </div>
        <div className="flex items-center justify-between gap-4"><span>{t('settings.font', 'Font')}</span>
          <Select value={font} onValueChange={v=>setFont(v as 'system'|'maple'|'jetbrains')}><SelectTrigger className="w-48"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="system">{t('common.system', 'System')}</SelectItem><SelectItem value="maple">Maple Mono</SelectItem><SelectItem value="jetbrains">JetBrains Mono</SelectItem></SelectContent></Select>
        </div>
      </CardContent>
    </Card>
    <Card><CardHeader><CardTitle>{t('sidebar.customize', 'Navigation')}</CardTitle></CardHeader><CardContent>
      <DropdownMenu><DropdownMenuTrigger asChild><Button variant="outline">{t('sidebar.customize', 'Customize sidebar')}</Button></DropdownMenuTrigger><DropdownMenuContent><SidebarCustomizer /></DropdownMenuContent></DropdownMenu>
    </CardContent></Card>
  </div>
}
