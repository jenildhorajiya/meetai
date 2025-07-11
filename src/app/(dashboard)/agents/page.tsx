import { AgentsView,AgentsViewLoading,AgentsViewError } from "@/modules/agents/ui/views/agents-view"
import { ErrorBoundary } from "react-error-boundary"
import { getQueryClient,trpc } from "@/trpc/server"
import { dehydrate, HydrationBoundary } from "@tanstack/react-query"
import { Suspense } from "react"

const Page = async ()=>{
    const queryClient=getQueryClient()
    void queryClient.prefetchQuery(trpc.agents.getMany.queryOptions())

    return (
        <HydrationBoundary state={dehydrate(queryClient)}>
            <Suspense fallback={<AgentsViewLoading/>}>
                <ErrorBoundary fallback={<AgentsViewError/>}>
                    <AgentsView/>
                </ErrorBoundary>
            </Suspense>
        </HydrationBoundary>
    )    
}
export default Page