import '@/i18n'

import { fireEvent, render, screen } from '@testing-library/react'
import i18n from 'i18next'
import { describe, expect, it, vi } from 'vitest'

import { ErrorMessage } from './error-message'
import { ResourceNotDiscoveredError } from '@/lib/dbx-resource-discovery'

describe('ErrorMessage', () => {
  it('renders nothing without an error', () => {
    const { container } = render(<ErrorMessage resourceName="Pods" error={null} refetch={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('keeps permanent errors visible and disables duplicate retry while fetching', async () => {
    await i18n.changeLanguage('en')
    const retry = vi.fn()
    const error = Object.assign(new Error('Forbidden'), { status: 403 })
    const view = render(<ErrorMessage resourceName="Pods" error={error} refetch={retry} isFetching />)
    expect(screen.getByRole('alert')).toHaveTextContent('Forbidden')
    fireEvent.click(screen.getByRole('button', { name: 'Try Again' }))
    expect(retry).not.toHaveBeenCalled()
    view.rerender(<ErrorMessage resourceName="Pods" error={error} refetch={retry} />)
    fireEvent.click(screen.getByRole('button', { name: 'Try Again' }))
    expect(retry).toHaveBeenCalledOnce()
  })

  it('shows a neutral notice when the cluster does not serve the resource', async () => {
    await i18n.changeLanguage('en')
    const error = new ResourceNotDiscoveredError('gateways')
    render(<ErrorMessage resourceName="Gateways" error={error} refetch={vi.fn()} />)
    const notice = screen.getByRole('status')
    expect(notice).toHaveTextContent('Resource not available in this cluster')
    expect(notice).toHaveTextContent('gateways')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('labels RBAC failures as missing permission instead of a load error', async () => {
    await i18n.changeLanguage('en')
    const error = Object.assign(new Error('Forbidden'), { status: 403 })
    render(<ErrorMessage resourceName="Gateways" error={error} refetch={vi.fn()} />)
    expect(screen.getByRole('alert')).toHaveTextContent('No permission to view this resource')
  })
})
