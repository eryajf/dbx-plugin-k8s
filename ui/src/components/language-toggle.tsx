import { languages, normalizeLocale } from '@/i18n/locale'
import { Languages } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

export function LanguageToggle() {
  const { i18n, t } = useTranslation()

  const handleLanguageChange = (languageCode: string) => {
    i18n.changeLanguage(languageCode)
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon">
          <Languages className="h-[1.2rem] w-[1.2rem]" />
          <span className="sr-only">{t('common.language')}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup
          value={normalizeLocale(i18n.resolvedLanguage || i18n.language)}
          onValueChange={handleLanguageChange}
        >
          {languages.map((language) => (
            <DropdownMenuRadioItem key={language.code} value={language.code}>
              {language.name}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
